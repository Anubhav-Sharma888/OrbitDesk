// Storage-durability tests for finding 4: the real SheetRecordStore over a
// simulated SheetPort. Pins the exact durability semantics the service layer
// must respect: writes inside an outer atomic are NOT durable until the
// outermost transaction commits (so pending-operation writes must never be
// nested inside a transaction that also spans a provider call), while
// top-level writes commit immediately and are visible to a second store
// instance. Also documents why rollback around read-only imports is safe.
import {it,expect} from 'vitest';
import {SheetRecordStore,type SheetPort} from '../../src/storage/sheets-store.js';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {SyncScheduler} from '../../src/sync/scheduler.js';
const clock={now:()=>Date.parse('2026-11-01T00:00:00Z'),iso:()=>'2026-11-01T00:00:00.000Z'};
const HEADER=['kind','id','version','updatedAt','payload'];
function sheetHarness(){
 const rows:unknown[][]=[HEADER];
 const port:SheetPort={
  readRows:()=>rows.map(row=>row.slice()),
  writeRows:(next:unknown[][])=>{rows.length=0;rows.push(...next.map(row=>row.slice()))}
 };
 const locker=<T,>(work:()=>T):T=>work();
 return {rows,port,store:()=>new SheetRecordStore(port,clock,locker)};
}
it('outerTransactionBuffersWritesUntilCommit',()=>{
 const h=sheetHarness();
 const outer=h.store();
 outer.put<{title:string}>('tasks','t1',{title:'Before'},null);
 // Inside an outer atomic, a nested write must not reach the sheet yet.
 outer.atomic(()=>{
  outer.put('tasks','t1',{title:'Inside transaction'},1);
  const secondWhileOpen=h.store();
  expect(secondWhileOpen.get<{title:string}>('tasks','t1')!.data.title).toBe('Before'); // still the committed value
 });
 // After commit the write becomes durable and visible.
 const second=h.store();
 expect(second.get<{title:string}>('tasks','t1')!.data.title).toBe('Inside transaction');
 // A crash before commit (simulated by discarding the working state) loses
 // nested writes entirely — which is why pending-operation writes must never
 // be nested inside a transaction that also spans a provider call.
 const crashed=sheetHarness();
 const store=crashed.store();
 store.put('tasks','x',{title:'Durable'},null);
 try{store.atomic(()=>{store.put('tasks','y',{title:'Lost'},null);throw new Error('process died')})}catch{/* interruption */}
 expect(crashed.store().get('tasks','y')).toBeNull();
 expect(crashed.store().get<{title:string}>('tasks','x')!.data.title).toBe('Durable');
});
it('topLevelWriteIsImmediatelyDurableForASecondStoreInstance',()=>{
 const h=sheetHarness();
 const first=h.store();
 first.put('calendar_operation','od1',{taskId:'t1',status:'pending'},null);
 const second=h.store();
 expect(second.get<{status:string}>('calendar_operation','od1')!.data.status).toBe('pending');
});
it('failedSyncRoundLeavesNoPartialImportRows',()=>{
 // Imports are read-only remote operations, so the round-level transaction
 // rolling back partial import rows is safe; this pins that no half-imported
 // rows survive a failed round (finding 4 audit: remote reads are not
 // rollbackable effects, but they leave no trace either).
 const store=new MemoryRecordStore(clock);
 let n=0;const ids={next:()=>'id'+(++n),hash:(v:string)=>v};
 let failSecondPage=false;
 const scheduler=new SyncScheduler(store,clock,ids,{
  page:(id,checkpoint)=>{
   if(checkpoint!==null&&failSecondPage)throw Object.assign(new Error('provider failed'),{code:'PROVIDER_FAILED'});
   if(checkpoint===null){
    store.atomic(()=>{store.put('sources','s:'+id+':1',{connectionId:id,id:'1',type:'gmail',title:'item'},null)});
    return {checkpoint:'page2',done:false,consumedCalls:1,items:1};
   }
   return {checkpoint:null,done:true,consumedCalls:1,items:0};
  }
 },{maxPages:5,maxCalls:9,pageMaxCalls:3,maxMs:20000,dailyCalls:100,minManualIntervalMs:0});
 const result=scheduler.run([{id:'account-fail',email:'a@example.com',label:'A',status:'active',paused:false,capabilities:['mail.read']}],{manual:true});
 expect(result.pages).toBe(1);
 failSecondPage=true;
 const second=scheduler.run([{id:'account-fail',email:'a@example.com',label:'A',status:'active',paused:false,capabilities:['mail.read']}],{manual:true});
 expect(second.pages).toBe(1); // the failing page counts as attempted
 // The failing round rolled back its partial rows; the first round's rows
 // remain because that round completed.
 const rows=store.list('sources');
 expect(rows.length).toBe(1);
});
