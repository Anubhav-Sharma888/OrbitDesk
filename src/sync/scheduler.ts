import {AppError,type Clock,type ConnectionView,type Ids,type RecordStore} from '../shared/contracts.js';
import {budgetPolicy,SyncBudgetLedger,type BudgetPolicy} from './budgets.js';
export type {BudgetPolicy} from './budgets.js';
export interface SyncPage {checkpoint:unknown|null;done:boolean;consumedCalls:number;items:number}
// Implementations persist source records/tasks idempotently before returning the new checkpoint.
// The port receives no AI client or send/calendar capability.
export interface SyncPort {page(connectionId:string,checkpoint:unknown|null,allowance:{maxCalls:number;deadlineAt:number}):SyncPage}
interface SchedulerState {lastConnectionId?:string;lastManualAt?:number;lease?:{id:string;expiresAt:number}}
interface AccountSyncState {checkpoint:unknown|null;lastSuccessAt?:string;lastAttemptAt?:string;nextAttemptAt?:number;failures:number;error?:string}
export interface SyncHealth {connectionId:string;checkpoint:unknown|null;lastSuccessAt?:string;ageMs?:number;nextAttemptAt?:number;error?:string}
export interface SyncRound {pages:number;items:number;calls:number;stopped:'disabled'|'busy'|'throttled'|'budget'|'time'|'round'|'complete'}
export class SyncScheduler {
 private policy:BudgetPolicy;private ledger:SyncBudgetLedger;
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids,private port:SyncPort,policy:Partial<BudgetPolicy>={}){this.policy=budgetPolicy(policy);this.ledger=new SyncBudgetLedger(store,clock,this.policy.dailyCalls)}
 run(connections:ConnectionView[],options:{manual?:boolean;automationEnabled?:boolean}={}):SyncRound {
  const result:SyncRound={pages:0,items:0,calls:0,stopped:'complete'};
  if(options.manual!==true&&options.automationEnabled!==true)return {...result,stopped:'disabled'};
  const runId=this.ids.next(),startedAt=this.clock.now(),deadlineAt=startedAt+this.policy.maxMs;
  const acquired=this.store.atomic(()=>{
   const row=this.store.get<SchedulerState>('sync_scheduler','owner'),state=row?.data??{};
   if(state.lease&&state.lease.expiresAt>startedAt)return 'busy';
   if(options.manual&&state.lastManualAt!==undefined&&startedAt-state.lastManualAt<this.policy.minManualIntervalMs)return 'throttled';
   this.store.put('sync_scheduler','owner',{...state,lease:{id:runId,expiresAt:startedAt+600000},...(options.manual?{lastManualAt:startedAt}:{})},row?.version??null);return 'acquired';
  });
  if(acquired!=='acquired')return {...result,stopped:acquired};
  try {
   const eligible=[...new Map(connections.filter(c=>c.status==='active'&&!c.paused&&c.capabilities.some(cap=>cap==='mail.read'||cap==='classroom.read')).map(c=>[c.id,c])).values()].sort((a,b)=>a.id.localeCompare(b.id));
   const last=this.store.get<SchedulerState>('sync_scheduler','owner')!.data.lastConnectionId;
   const next=last?eligible.findIndex(c=>c.id>last):0,start=next<0?0:next;
   const ordered=[...eligible.slice(start),...eligible.slice(0,start)];
   for(const connection of ordered){
    if(result.pages>=this.policy.maxPages){result.stopped='round';break}
    if(this.clock.now()>=deadlineAt){result.stopped='time';break}
    const account=this.store.get<AccountSyncState>('sync_accounts',connection.id)?.data;
    if(account?.nextAttemptAt&&account.nextAttemptAt>this.clock.now())continue;
    const remaining=this.policy.maxCalls-result.calls;
    if(remaining<=0){result.stopped='budget';break}
    const reservation=this.ledger.reserve(Math.min(this.policy.pageMaxCalls,remaining));
    if(!reservation.calls){result.stopped='budget';break}
    this.store.atomic(()=>{const row=this.store.get<SchedulerState>('sync_scheduler','owner')!;this.assertLease(row.data,runId);this.store.put('sync_scheduler','owner',{...row.data,lastConnectionId:connection.id},row.version)});
    result.pages++;
    try {
     const page=this.port.page(connection.id,account?.checkpoint??null,{maxCalls:reservation.calls,deadlineAt});
     if(typeof page.done!=='boolean'||!Number.isSafeInteger(page.consumedCalls)||page.consumedCalls<0||page.consumedCalls>reservation.calls||!Number.isSafeInteger(page.items)||page.items<0||JSON.stringify(page.checkpoint??null).length>10000)throw new AppError('SYNC_CONTRACT','Sync page exceeded its bounded contract');
     this.store.atomic(()=>{
      this.assertLease(this.store.get<SchedulerState>('sync_scheduler','owner')!.data,runId);
      const row=this.store.get<AccountSyncState>('sync_accounts',connection.id);
      this.store.put<AccountSyncState>('sync_accounts',connection.id,{checkpoint:page.checkpoint??null,failures:0,lastAttemptAt:this.clock.iso(),...(page.done?{lastSuccessAt:this.clock.iso()}:account?.lastSuccessAt?{lastSuccessAt:account.lastSuccessAt}:{})},row?.version??null);
      this.ledger.settle(reservation,page.consumedCalls);
     });
     result.calls+=page.consumedCalls;result.items+=page.items;
     if(!page.done&&result.calls>=this.policy.maxCalls)result.stopped='budget';
    }catch(error){
     // Unknown call consumption keeps the entire reservation charged. Other accounts continue.
     result.calls+=reservation.calls;
     this.store.atomic(()=>{
      this.assertLease(this.store.get<SchedulerState>('sync_scheduler','owner')!.data,runId);
      const row=this.store.get<AccountSyncState>('sync_accounts',connection.id),failures=(row?.data.failures??0)+1;
      const seconds=error instanceof AppError&&error.retryAfterSeconds?Math.min(3600,Math.max(1,error.retryAfterSeconds)):Math.min(3600,60*2**Math.min(failures-1,6));
      this.store.put<AccountSyncState>('sync_accounts',connection.id,{...(row?.data??{checkpoint:null}),failures,lastAttemptAt:this.clock.iso(),nextAttemptAt:this.clock.now()+seconds*1000,error:error instanceof AppError&&error.code==='RATE_LIMITED'?'Provider usage limit; this account will resume later':'This account needs a later sync attempt'},row?.version??null);
     });
    }
   }
   return result;
  }finally{
   this.store.atomic(()=>{const row=this.store.get<SchedulerState>('sync_scheduler','owner');if(row?.data.lease?.id===runId){const state={...row.data};delete state.lease;this.store.put('sync_scheduler','owner',state,row.version)}});
  }
 }
 health(connections:ConnectionView[]):SyncHealth[]{return connections.map(connection=>{const data=this.store.get<AccountSyncState>('sync_accounts',connection.id)?.data;return {connectionId:connection.id,checkpoint:data?.checkpoint??null,...(data?.lastSuccessAt?{lastSuccessAt:data.lastSuccessAt,ageMs:Math.max(0,this.clock.now()-Date.parse(data.lastSuccessAt))}:{}),...(data?.nextAttemptAt?{nextAttemptAt:data.nextAttemptAt}:{}),...(data?.error?{error:data.error}:{})}})}
 private assertLease(state:SchedulerState,id:string):void{if(state.lease?.id!==id||state.lease.expiresAt<=this.clock.now())throw new AppError('SYNC_LEASE_LOST','This sync round no longer owns the lock')}
}
