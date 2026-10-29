import {AppError,type Clock,type RecordStore} from '../shared/contracts.js';
export interface BudgetPolicy {maxPages:number;maxCalls:number;pageMaxCalls:number;maxMs:number;dailyCalls:number;minManualIntervalMs:number}
export const defaultBudgetPolicy:BudgetPolicy={maxPages:3,maxCalls:15,pageMaxCalls:5,maxMs:20000,dailyCalls:500,minManualIntervalMs:15000};
export function budgetPolicy(patch:Partial<BudgetPolicy>):BudgetPolicy {
 const policy={...defaultBudgetPolicy,...patch};
 for(const [key,value] of Object.entries(policy))if(!Number.isSafeInteger(value)||value<(key==='minManualIntervalMs'?0:1))throw new AppError('INVALID_BUDGET','Sync budgets must be positive bounded integers');
 if(policy.maxPages>100||policy.maxCalls>500||policy.pageMaxCalls>100||policy.maxMs>240000||policy.dailyCalls>10000)throw new AppError('INVALID_BUDGET','Sync budget exceeds the conservative free-use boundary');
 return policy;
}
interface DailyBudget {reservedCalls:number}
export interface Reservation {day:string;calls:number}
export class SyncBudgetLedger {
 constructor(private store:RecordStore,private clock:Clock,private dailyLimit:number){}
 reserve(requested:number):Reservation {
  return this.store.atomic(()=>{
   const day=new Date(this.clock.now()).toISOString().slice(0,10),row=this.store.get<DailyBudget>('sync_budgets',day);
   const used=row?.data.reservedCalls??0,calls=Math.max(0,Math.min(requested,this.dailyLimit-used));
   if(calls)this.store.put('sync_budgets',day,{reservedCalls:used+calls},row?.version??null);
   return {day,calls};
  });
 }
 settle(reservation:Reservation,used:number):void {
  if(!Number.isSafeInteger(used)||used<0||used>reservation.calls)throw new AppError('SYNC_CONTRACT','Sync page exceeded its reserved call budget');
  this.store.atomic(()=>{const row=this.store.get<DailyBudget>('sync_budgets',reservation.day);if(!row)return;this.store.put('sync_budgets',reservation.day,{reservedCalls:Math.max(0,row.data.reservedCalls-(reservation.calls-used))},row.version)});
 }
}
