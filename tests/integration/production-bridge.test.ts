// Production-wiring RED tests: these drive the REAL src/app/entrypoints.ts
// scheduledSync() through in-memory Apps Script fakes (real SheetRecordStore
// over a simulated Sheet, real GoogleTransport, real OAuthBroker, fake
// OAuth2/UrlFetchApp). Findings covered: 3. background-grant isolation for
// scheduled calendar operations, 4. durable pending operations before
// provider calls (plus interruption recovery), 6. capability-aware import
// bridge. These tests FAIL against the current code.
import {it,expect,beforeAll,afterAll} from 'vitest';
import {installAppScriptFakes,SHEET_HEADER,type FakeHttpRequest} from '../helpers/appsscript-fakes.js';
import {SheetRecordStore} from '../../src/storage/sheets-store.js';

const owner='owner@example.com';
const now='2026-11-01T00:00:00.000Z';
let env:ReturnType<typeof installAppScriptFakes>;
beforeAll(()=>{env=installAppScriptFakes(owner)});
afterAll(()=>{env.restore()});
const GMAIL='gmail.googleapis.com',CAL='www.googleapis.com/calendar',CLASSROOM='classroom.googleapis.com';
interface CalendarState{events:Map<string,Record<string,unknown>>}
function calendarHandler(state:CalendarState,durability?:{pendingAtCall:string[]}){
 return (call:FakeHttpRequest):{status:number;json:unknown}=>{
  const url=call.url;
  if(url.includes('/users/me/calendarList'))return {status:200,json:{items:[{id:'calA',summary:'Cal A',accessRole:'owner'}]}};
  if(/\/calendars\/calA\/events\/od[a-f0-9]+\?sendUpdates=none$/.test(url)){
   const eventId=url.split('/events/')[1]!.split('?')[0]!;
   if(call.method==='DELETE'){state.events.delete(eventId);return {status:200,json:{}}}
   if(call.method==='PATCH'){const current=state.events.get(eventId);if(!current)return {status:404,json:{error:{code:404,message:'Not Found'}}};const body=JSON.parse(call.payload??'{}') as Record<string,unknown>;const updated={...current,...body,etag:'"2"'};state.events.set(eventId,updated);return {status:200,json:updated}}
  }
  if(/\/calendars\/calA\/events\?sendUpdates=none$/.test(url)&&call.method==='POST'){
   const body=JSON.parse(call.payload??'{}') as Record<string,unknown>;
   // Durability probe: at provider-call time the sheet must already hold the
   // pending operation row for this event (finding 4).
   if(durability){
    const pending=env.sheetRows.some(row=>row[0]==='calendar_operation'&&String(row[4]).includes('"status":"pending"')&&String(row[4]).includes('"eventId":"'+String(body.id)+'"'));
    if(!pending)durability.pendingAtCall.push(String(body.id));
   }
   const event={...body,etag:'"1"'};state.events.set(String(body.id),event);return {status:200,json:event};
  }
  if(/\/calendars\/calA\/events\/od[a-f0-9]+$/.test(url)){
   const eventId=url.split('/events/')[1]!;
   const event=state.events.get(eventId);
   return event?{status:200,json:event}:{status:404,json:{error:{code:404,message:'Not Found'}}};
  }
  if(url.includes(GMAIL+'/gmail/v1/users/me/profile'))return {status:200,json:{historyId:'1000'}};
  if(url.includes(GMAIL+'/gmail/v1/users/me/messages?'))return {status:200,json:{messages:[],resultSizeEstimate:0}};
  if(url.includes(GMAIL+'/gmail/v1/users/me/history'))return {status:200,json:{history:[],historyId:'1000'}};
  if(url.includes(GMAIL+'/gmail/v1/users/me/messages/'))return {status:200,json:{id:url.split('/messages/')[1]!.split('?')[0]!,snippet:'assignment',historyId:'1000'}};
  if(url.includes(CLASSROOM+'/v1/courses?'))return {status:200,json:{courses:[]}};
  return {status:200,json:{}};
 };
}
function connection(id:string,serviceName:string,agentServiceName:string|undefined,caps:string[],backgroundCaps:string[]):Record<string,unknown>{
 return {id,subject:id.replace('google:',''),serviceName,agentServiceName,email:'user-'+id.replace('google:','')+'@example.com',label:id,status:'active',capabilities:caps,paused:false,backgroundCapabilities:backgroundCaps};
}
function seedWorkspace(){
 env.sheetRows.length=0;
 env.httpCalls.length=0; // request assertions are per-test
 env.sheetRows.push(SHEET_HEADER);
 env.sheetRows.push(['settings','owner',1,now,JSON.stringify({timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90})]);
 env.properties['STORAGE_SPREADSHEET_ID']='sheet-1';
 // Fresh connection state per test: stale connections from earlier tests
 // would consume the scheduler's bounded page allowance before this test's
 // own accounts are polled.
 for(const key of Object.keys(env.properties))if(key.startsWith('connection:'))delete env.properties[key];
}
function seedConnection(view:Record<string,unknown>){env.properties['connection:'+view.id]=JSON.stringify(view)}
function seedRule(connectionId:string){
 env.sheetRows.push(['routes','rule-1',1,now,JSON.stringify({id:'rule-1',version:1,label:'Coursework to calendar',sourceConnectionIds:[connectionId],priority:0,enabled:true,conditions:{},decision:{mode:'automatic',destinations:[{connectionId,calendarId:'calA'}]}})]);
}
function seedRoutedTask(taskId:string,connectionId:string){
 // No source row is needed here: the seeded rule has no sender/keyword
 // conditions, so only the task's sourceRefs connection matters for routing.
 const createdAt='2026-11-01T00:00:00.000Z';
 env.sheetRows.push(['tasks',taskId,1,createdAt,JSON.stringify({id:taskId,version:1,title:'Submit report',notes:'',status:'open',kind:'gmail',officialDue:{kind:'date',date:'2026-11-05'},sourceRefs:[{connectionId,type:'gmail',id:'m-'+taskId}],confidence:'clear',createdAt,updatedAt:createdAt})]);
}
async function runScheduledSync():Promise<{status:string;pages:number;items:number}>{
 const mod=await import('../../src/app/entrypoints.js');
 const result=mod.scheduledSync({}) as {status:string;pages:number;items:number;error?:{code:string;message:string}};
 if(result.status==='error')console.log('scheduledSync error:',JSON.stringify(result.error));
 return result;
}
const bothCaps=['mail.read','calendar.list','calendar.read','calendar.write','classroom.read'];

it('scheduledReconcileUsesBackgroundGrant',async()=>{
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 env.onRequest(calendarHandler(state));
 seedConnection(connection('google:sub1','svc-manual-1','svc-agent-1',bothCaps,bothCaps));
 seedRule('google:sub1');
 seedRoutedTask('task-1','google:sub1');
 const result=await runScheduledSync();
 expect(result.status).toBe('ok');
 const insert=env.httpCalls.find(call=>call.method==='POST'&&/\/calendars\/calA\/events\?sendUpdates=none$/.test(call.url));
 expect(insert).toBeTruthy(); // the scheduled reconcile created the managed event
 // The calendar write must carry the AGENT grant's token, not the manual one.
 expect(insert!.headers.Authorization).toBe('Bearer token:svc-agent-1'); // RED today: manual grant token
});

it('missingBackgroundGrantFailsClosed',async()=>{
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 env.onRequest(calendarHandler(state));
 // No agent grant at all: no agentServiceName, no background capabilities.
 seedConnection(connection('google:sub2','svc-manual-2',undefined,bothCaps,[]));
 seedRule('google:sub2');
 seedRoutedTask('task-2','google:sub2');
 const result=await runScheduledSync();
 expect(result.status).toBe('ok');
 const calendarWrites=env.httpCalls.filter(call=>call.url.includes('/calendars/calA/events')&&call.method!=='GET');
 // Fail closed: no calendar write may ride the manual credentials when the
 // background grant is missing.
 for(const call of calendarWrites)expect(call.headers.Authorization).not.toBe('Bearer token:svc-manual-2'); // RED today: manual transport writes
 expect(calendarWrites).toHaveLength(0); // RED today: the manual grant performed the write
});

it('importBridgeSelectsProvidersByCapability',async()=>{
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 env.onRequest(calendarHandler(state));
 seedConnection(connection('google:gmail-only','svc-manual-g','svc-agent-g',['mail.read','calendar.list'],['mail.read']));
 seedConnection(connection('google:classroom-only','svc-manual-c','svc-agent-c',['classroom.read','calendar.list'],['classroom.read']));
 seedConnection(connection('google:combined','svc-manual-b','svc-agent-b',bothCaps,bothCaps));
 await runScheduledSync();
 // Classroom-only account: Classroom must be synchronized, and Gmail must
 // never be attempted (not even a denied request).
 expect(env.httpCalls.filter(call=>call.url.includes(CLASSROOM)&&call.headers.Authorization==='Bearer token:svc-agent-c').length).toBeGreaterThan(0); // RED today: 0
 expect(env.httpCalls.filter(call=>call.url.includes(GMAIL)&&call.headers.Authorization==='Bearer token:svc-agent-c')).toHaveLength(0);
 // Gmail-only account: Gmail synchronizes; the missing Classroom permission
 // must not fail the account after its Gmail work succeeded.
 expect(env.httpCalls.filter(call=>call.url.includes(GMAIL)&&call.headers.Authorization==='Bearer token:svc-agent-g').length).toBeGreaterThan(0);
 expect(env.httpCalls.filter(call=>call.url.includes(CLASSROOM)&&call.headers.Authorization==='Bearer token:svc-agent-g')).toHaveLength(0);
 const gmailOnlyRow=env.sheetRows.find(row=>row[0]==='sync_accounts'&&row[1]==='google:gmail-only');
 expect(gmailOnlyRow).toBeTruthy();
 expect(String(gmailOnlyRow![4])).not.toContain('"error"'); // RED today: page throws MISSING_PERMISSION after Gmail succeeded
 // Combined account: both providers make bounded progress.
 expect(env.httpCalls.filter(call=>call.url.includes(GMAIL)&&call.headers.Authorization==='Bearer token:svc-agent-b').length).toBeGreaterThan(0);
 expect(env.httpCalls.filter(call=>call.url.includes(CLASSROOM)&&call.headers.Authorization==='Bearer token:svc-agent-b').length).toBeGreaterThan(0);
});

it('scheduledRoundsPollAccountsWithBackgroundOnlyReadCaps',async()=>{
 // Scheduler eligibility must consider background capabilities on scheduled
 // rounds: an account whose MANUAL grant has no read permission but whose
 // background grant does is polled (requests re-validate per call).
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 env.onRequest(calendarHandler(state));
 seedConnection(connection('google:background-only','svc-manual-bg','svc-agent-bg',['calendar.list'],['mail.read']));
 const result=await runScheduledSync();
 expect(result.status).toBe('ok');
 expect(env.httpCalls.filter(call=>call.url.includes(GMAIL)&&call.headers.Authorization==='Bearer token:svc-agent-bg').length).toBeGreaterThan(0);
 expect(env.httpCalls.filter(call=>call.url.includes(CLASSROOM)&&call.headers.Authorization==='Bearer token:svc-agent-bg')).toHaveLength(0);
});

it('pendingOperationIsDurableBeforeProviderCall',async()=>{
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 const durability:{pendingAtCall:string[]}={pendingAtCall:[]};
 env.onRequest(calendarHandler(state,durability));
 seedConnection(connection('google:sub3','svc-manual-3','svc-agent-3',bothCaps,bothCaps));
 seedRule('google:sub3');
 seedRoutedTask('task-3','google:sub3');
 await runScheduledSync();
 // At the moment the calendar HTTP insert fired, the pending operation row
 // must already be committed to the simulated Sheet (finding 4).
 expect(durability.pendingAtCall).toEqual([]); // RED today: whole pass buffered until the outer atomic commits
 // A second store instance over the same sheet sees the completed operation
 // rows for the real managed event ids.
 const second=new SheetRecordStore({readRows:()=>env.sheetRows.map(row=>row.slice()),writeRows:()=>{}}, {now:()=>Date.now(),iso:()=>new Date().toISOString()},<T,>(work:()=>T):T=>work());
 const createdEventId=[...state.events.keys()][0]!;
 const operation=second.get<{status:string}>('calendar_operation',createdEventId);
 expect(operation?.data.status).toBe('complete');
});

it('interruptionRecoveryWithoutDuplicateEvents',async()=>{
 seedWorkspace();
 const state:CalendarState={events:new Map()};
 let failNextInsert=false;
 const base=calendarHandler(state);
 env.onRequest(call=>{
  if(call.method==='POST'&&/\/calendars\/calA\/events\?sendUpdates=none$/.test(call.url)&&failNextInsert){failNextInsert=false;return {status:503,json:{error:{code:503,message:'Backend Error'}}}}
  return base(call);
 });
 seedConnection(connection('google:sub4','svc-manual-4','svc-agent-4',bothCaps,bothCaps));
 seedRule('google:sub4');
 seedRoutedTask('task-4a','google:sub4');
 seedRoutedTask('task-4b','google:sub4');
 const first=await runScheduledSync();
 expect(first.status).toBe('ok');
 expect(state.events.size).toBeGreaterThan(0);
 // Interrupt the next round mid-provider-call; recover with fresh service
 // executions over the same sheet.
 failNextInsert=true;
 await runScheduledSync();
 const recovered=await runScheduledSync();
 expect(recovered.status).toBe('ok');
 // Every eligible task has exactly one managed event; no duplicates survived.
 const linkRows=env.sheetRows.filter(row=>row[0]==='calendar_link');
 expect(linkRows).toHaveLength(2);
 const postedIds=new Set<string>();
 for(const row of linkRows)postedIds.add(String((JSON.parse(String(row[4])) as {eventId:string}).eventId));
 expect(postedIds.size).toBe(2);
 expect(state.events.size).toBe(2);
 // No pending operation rows may be stranded without a terminal outcome.
 for(const row of env.sheetRows.filter(row=>row[0]==='calendar_operation'))expect(String(row[4])).not.toContain('"status":"pending"');
});
