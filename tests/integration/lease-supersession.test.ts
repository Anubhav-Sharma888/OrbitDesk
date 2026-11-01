// Deterministic two-worker lease-supersession scenario with simulated time,
// driven through the real reconcile stage on one shared store (real storage
// abstraction; a SheetRecordStore variant proves the same semantics over the
// simulated Sheet). Question: after worker A's lease expires and worker B
// acquires, what can a RESUMED A still do — initiate new calendar operations,
// overwrite pending-operation state, clobber B's cursor, or interfere?
import {it,expect} from 'vitest';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {SheetRecordStore,type SheetPort} from '../../src/storage/sheets-store.js';
import {AppService} from '../../src/app/service.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {TaskService} from '../../src/tasks/task-service.js';
import {managedEventId} from '../../src/routing/reconcile.js';
import type {RecordStore} from '../../src/shared/contracts.js';
import type {CalendarPort,CalendarEvent,ManagedCalendarEvent} from '../../src/providers/google-calendar.js';
const owner='owner@example.com';
const START=Date.parse('2026-11-01T00:00:00Z');
const T2='task:gmail:google:subject123:m2';
const dest={connectionId:'google:subject123',calendarId:'google:subject123-calendar'};
function hexIds(){let n=0;return {next:()=>'id'+(++n),hash:(v:string)=>Buffer.from(v).toString('hex')}}
const codec={encodeBase64Url:(s:string)=>Buffer.from(s).toString('base64url'),decodeBase64Url:(s:string)=>Buffer.from(s,'base64url').toString('utf8'),encodeBase64:(s:string)=>Buffer.from(s).toString('base64')};
function fakeBroker(clock:import('../../src/shared/contracts.js').Clock){return new OAuthBroker({owner,secrets:new MemorySecrets(),clock,ids:hexIds(),factory:{service:()=>({
 authorizationUrl:()=>'https://accounts.google.com/o/oauth2/v2/auth?fixture=1',exchange:()=>true,
 identity:()=>({sub:'subject123',email:'student@example.com',emailVerified:true,scopes:['openid']}),
 accessToken:()=>'fixture-access-value',reset:()=>{}})}})}
function item(index:string){return {connectionId:dest.connectionId,id:'m'+index,type:'gmail' as const,title:'Report '+index,text:'Please submit your lab report '+index+' by 2026-11-02',receivedAt:new Date(START).toISOString(),updatedAt:new Date(START).toISOString(),sender:'Lecturer <teacher@example.com>',threadId:'t'+index,rfcMessageId:'<m'+index+'@example.com>'}}
function harness(withSheet:boolean){
 const mutable={now:START};
 const clock={now:()=>mutable.now,iso:()=>new Date(mutable.now).toISOString()};
 let store:RecordStore;
 const rows:unknown[][]=[['kind','id','version','updatedAt','payload']];
 if(withSheet){
  const port:SheetPort={readRows:()=>rows.map(r=>r.slice()),writeRows:(next)=>{rows.length=0;rows.push(...next.map(r=>r.slice()))}};
  store=new SheetRecordStore(port,clock,<T,>(work:()=>T):T=>work());
 }else store=new MemoryRecordStore(clock);
 store.put('settings','owner',{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90},null);
 const sharedIds=hexIds();
 const events=new Map<string,CalendarEvent>();
 const writes:{who:string;what:string;id:string}[]=[];
 let staleInsertT2='';
 let hookFired=false;
 const makePort=(who:string,afterInsert?:()=>void):CalendarPort=>({
  listCalendars:(connectionId:string)=>[{connectionId,id:dest.calendarId,summary:'Cal',accessRole:'writer',writable:true}],
  get:(destination,id)=>structuredClone(events.get(id)??null),
  insert:(destination,body:ManagedCalendarEvent)=>{
   const event:CalendarEvent={...structuredClone(body),etag:'"1"'};
   events.set(body.id,event);
   writes.push({who,what:'POST',id:body.id});
   if(who==='A'&&hookFired&&body.id===managedEventId(T2,dest,sharedIds))staleInsertT2=body.id;
   if(who==='A')afterInsert?.();
   return structuredClone(event);
  },
  update:(destination,body:ManagedCalendarEvent,etag:string)=>{
   const current=events.get(body.id);
   if(!current||current.etag!==etag)throw Object.assign(new Error('conflict'),{code:'REMOTE_CONFLICT'});
   const event:CalendarEvent={...structuredClone(body),etag:'"2"'};events.set(body.id,event);writes.push({who,what:'PATCH',id:body.id});return structuredClone(event)},
  delete:(destination,id,etag:string)=>{
   const current=events.get(id);
   if(!current||current.etag!==etag)throw Object.assign(new Error('conflict'),{code:'REMOTE_CONFLICT'});
   events.delete(id);writes.push({who,what:'DELETE',id})}});
 const tasks=new TaskService(store,clock,sharedIds);
 for(const index of ['1','2']){store.put('sources','gmail:google:subject123:m'+index,item(index),null);tasks.importSource(item(index))}
 const connect=()=>{const broker=fakeBroker(clock);const pending=broker.beginConnection(owner,['mail.read']);broker.completeConnection(owner,{pendingId:pending.pendingId,serviceName:pending.serviceName,code:'x'});return broker};
 const brokerA=connect(),brokerB=connect();
 let workerB!:AppService;
 const workerA=new AppService({owner,store,clock,ids:sharedIds,codec,http:{fetch:()=>({status:0,json:null})},broker:brokerA,calendars:makePort('A',()=>{
  if(hookFired)return;
  hookFired=true;
  mutable.now+=601_000;
  const t2=store.get<{version:number}>('tasks',T2);
  if(t2)store.remove('tasks',T2,t2.version);
  workerB.runScheduledSync();
 }),syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:0})}});
 workerB=new AppService({owner,store,clock,ids:sharedIds,codec,http:{fetch:()=>({status:0,json:null})},broker:brokerB,calendars:makePort('B'),syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:0})}});
 workerA.handle({kind:'user',email:owner},{type:'route.save',requestId:'rule-1',payload:{rule:{label:'auto',sourceConnectionIds:[dest.connectionId],priority:0,enabled:true,conditions:{},decision:{mode:'automatic',destinations:[{connectionId:dest.connectionId,calendarId:dest.calendarId}]}}}});
 return {
  sharedIds,store,events,writes,
  staleInsertT2:()=>staleInsertT2,
  cursor:()=>store.get<{last?:string}>('reconcile_cursor','owner')?.data.last,
  t2LinkExists:()=>store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===T2),
  reconcileMessages:()=>store.list<{kind:string;message:string}>('activity').map(r=>r.data).filter(m=>m.kind==='reconcile').map(m=>m.message),
  runA:()=>workerA.runScheduledSync(),
  runB:()=>workerB.runScheduledSync()
 };
}
for(const variant of [false,true] as const){
 const label=variant?'SheetRecordStore':'MemoryRecordStore';
 it('stale worker stops initiating operations after supersession ('+label+')',()=>{
  const h=harness(variant);
  expect(h.runA().status).toBe('ok');
  // Worker B superseded A mid-pass: B acquired the expired lease and ran its
  // own pass, finishing A's in-flight T1 insert; T2's task row had been
  // merge-removed and T2 held no link, so B never touches T2.
  const t2EventId=managedEventId(T2,dest,h.sharedIds);
  // RED today: the resumed stale worker A re-inserts T2's event.
  expect(h.staleInsertT2()).toBe('');
  expect(h.events.has(t2EventId)).toBe(false);
  expect(h.t2LinkExists()).toBe(false);
  // B's cursor survived A's resume: it points at T1, the last task B's pass
  // processed — a value pin, so A clobbering or advancing the cursor fails.
  expect(h.cursor()).toBe(new Date(START).toISOString()+':task:gmail:google:subject123:m1');
  // The superseded pass reports honestly instead of finishing silently.
  expect(h.reconcileMessages().join(' | ')).toMatch(/superseded/i);
 });
 it('in-flight operation still records its durable outcome ('+label+')',()=>{
  const h=harness(variant);
  const t1Id=managedEventId('task:gmail:google:subject123:m1',dest,h.sharedIds);
  expect(h.runA().status).toBe('ok');
  // A's insert that was already in flight when the lease expired: the remote
  // event exists, the link row exists, and the operation row reached a
  // terminal status — recovery is idempotent, nothing is stranded pending.
  expect(h.events.has(t1Id)).toBe(true);
  expect(h.store.get<{status:string}>('calendar_operation',t1Id)?.data.status).toBe('complete');
 });
}
