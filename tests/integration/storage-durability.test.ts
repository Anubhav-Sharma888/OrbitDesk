// Storage-durability tests for finding 4: the real SheetRecordStore over a
// simulated SheetPort. Pins the exact durability semantics the service layer
// must respect: writes inside an outer atomic are NOT durable until the
// outermost transaction commits (so pending-operation writes must never be
// nested inside a transaction that also spans a provider call), while
// top-level writes commit immediately and are visible to a second store
// instance. Also documents why rollback around read-only imports is safe.
import {it,expect} from 'vitest';
import {SheetRecordStore,AppsSheetPort,protectSheetCell,type SheetPort} from '../../src/storage/sheets-store.js';
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
// Models Google Sheets' input interpretation for the one coercion this
// application can hit: a bare YYYY-MM-DD string cell is stored as a numeric
// date serial (observed live 2026-11-15 on the sync_budgets id). A leading
// apostrophe forces text storage; getValues strips it again.
function coercingFakeSheet(){
 const stored:unknown[][]=[HEADER.slice()];
 const serial=(d:string)=>Math.floor((Date.parse(d)-Date.UTC(1899,11,30))/86400000);
 const coerce=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?serial(v):v;
 const unquote=(v:unknown)=>typeof v==='string'&&v.startsWith("'")?v.slice(1):v;
 const fakeSheet:any={
  getLastRow:()=>stored.length,
  getMaxRows:()=>Math.max(stored.length,100),
  getRange:(r:number,c:number,nr:number,nc:number)=>({
   getValues:()=>{const out:unknown[][]=[];for(let i=0;i<nr;i++){const src=stored[r-1+i]??[];const line:unknown[]=[];for(let j=0;j<nc;j++)line.push(unquote(src[c-1+j]??''));out.push(line)}return out},
   setValues:(v:unknown[][])=>{for(let i=0;i<v.length;i++){while(stored.length<=r-1+i)stored.push([]);stored[r-1+i]=v[i].map(coerce)}}
  }),
  insertRowsAfter:(after:number,count:number)=>{stored.splice(after,0,...Array.from({length:count},()=>[]))}};
 return {stored,fakeSheet};
}
it('dateLikeIdsSurviveGoogleSheetsCoercion',()=>{
 // Live incident 2026-11-15: the sync_budgets record id '2026-11-14' was
 // stored as date serial 46340, and the record parser failed closed with
 // STORAGE_CORRUPT on every later read. The writeRows guard must keep
 // date-like ids as text so reads return the original string id.
 const {stored,fakeSheet}=coercingFakeSheet();
 (globalThis as any).SpreadsheetApp={flush:()=>{}};
 try{
  const day=new Date(clock.now()).toISOString().slice(0,10);
  const first=new SheetRecordStore(new AppsSheetPort(fakeSheet),clock,<T,>(w:()=>T):T=>w());
  first.put('sync_budgets',day,{reserved:2,settle:0},null);
  expect(stored[1][1]).toBe("'"+day); // guard prefixed the id before Sheets could coerce
  const second=new SheetRecordStore(new AppsSheetPort(fakeSheet),clock,<T,>(w:()=>T):T=>w());
  const row=second.get<{reserved:number}>('sync_budgets',day);
  expect(row).not.toBeNull(); // RED today: id was stored as a serial number
  expect(row!.id).toBe(day);
  expect(row!.data.reserved).toBe(2);
 }finally{delete (globalThis as any).SpreadsheetApp}
});
it('protectSheetCellOnlyTouchesBareDateStrings',()=>{
 expect(protectSheetCell('2026-11-15')).toBe("'2026-11-15");
 expect(protectSheetCell('2026-11-15T19:59:00.000Z')).toBe('2026-11-15T19:59:00.000Z'); // datetimes with time+zone never coerce (observed)
 expect(protectSheetCell('gmail:google:110308993223414888071')).toBe('gmail:google:110308993223414888071');
 expect(protectSheetCell('{"json":"object"}')).toBe('{"json":"object"}');
 expect(protectSheetCell(46340)).toBe(46340);
 expect(protectSheetCell(null)).toBe(null);
});
