// RED reproduction tests for the reconcile-stage production defects:
// 1. fair rotation (oldest-first slice starves the tail), 2. routing
// consistency (execution omits source records), 5. managed-event lifecycle
// (cleanup paths unreachable). These tests FAIL against the current code;
// the fix phase makes them green without weakening their assertions.
import {it,expect} from 'vitest';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {AppService,type AppServiceDeps} from '../../src/app/service.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {TaskService} from '../../src/tasks/task-service.js';
import {RoutingService} from '../../src/routing/rules.js';
import {managedEventId} from '../../src/routing/reconcile.js';
import type {CalendarPort,CalendarEvent,ManagedCalendarEvent} from '../../src/providers/google-calendar.js';
import type {Codec,ConnectionView,Destination,RpcResponse,SecretStore,SourceItem,Task} from '../../src/shared/contracts.js';

const owner='owner@example.com';
const actor={kind:'user' as const,email:owner};
const clock={now:()=>Date.parse('2026-11-01T00:00:00Z'),iso:()=>'2026-11-01T00:00:00.000Z'};
function okValue<T=unknown>(result:RpcResponse):T{if(!result.ok)throw Error('expected ok: '+result.error.code+' '+result.error.message);return result.value as T}
function ids(){let n=0;return {next:()=>'id'+(++n),hash:(v:string)=>v}}
function hexIds(){let n=0;return {next:()=>'id'+(++n),hash:(v:string)=>Buffer.from(v).toString('hex')}}
const codec:Codec={encodeBase64Url:s=>Buffer.from(s).toString('base64url'),decodeBase64Url:s=>Buffer.from(s,'base64url').toString('utf8'),encodeBase64:s=>Buffer.from(s).toString('base64')};
const http={fetch:()=>({status:0,json:null})};
function fakeBroker(){return new OAuthBroker({owner,secrets:new MemorySecrets() as SecretStore,clock,ids:ids(),factory:{service:()=>({
 authorizationUrl:()=>'https://accounts.google.com/o/oauth2/v2/auth?fixture=1',exchange:()=>true,
 identity:()=>({sub:'subject123',email:'student@example.com',emailVerified:true,scopes:['openid','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email']}),
 accessToken:()=>'fixture-access-value',reset:()=>{}})}})}
function connect(broker:OAuthBroker):ConnectionView{const p=broker.beginConnection(owner,['mail.read']);return broker.completeConnection(owner,{pendingId:p.pendingId,serviceName:p.serviceName,code:'x'}).connection!}
// Two writable calendars per connection so route changes have somewhere to go.
function fakeCalendarPort(){
 const events=new Map<string,CalendarEvent>();
 const writes:{method:string;destination?:Destination;body?:ManagedCalendarEvent;etag?:string}[]=[];
 const key=(destination:Destination,id:string)=>destination.connectionId+'|'+destination.calendarId+'|'+id;
 const port:CalendarPort={
  listCalendars:(connectionId:string)=>[
   {connectionId,id:connectionId+'-calendar',summary:connectionId+' primary',accessRole:'writer',writable:true},
   {connectionId,id:connectionId+'-calendar-2',summary:connectionId+' second',accessRole:'owner',writable:true}],
  get:(destination,id)=>structuredClone(events.get(key(destination,id))??null),
  insert:(destination,body)=>{const k=key(destination,body.id);
   if(events.has(k))throw Object.assign(new Error('exists'),{code:'ALREADY_EXISTS'});
   const event:CalendarEvent={...structuredClone(body),etag:'"1"'};events.set(k,event);writes.push({method:'POST',destination,body:structuredClone(body)});return structuredClone(event)},
  update:(destination,body,etag)=>{const k=key(destination,body.id),current=events.get(k);
   if(!current||current.etag!==etag)throw Object.assign(new Error('conflict'),{code:'REMOTE_CONFLICT'});
   const event:CalendarEvent={...structuredClone(body),etag:'"2"'};events.set(k,event);writes.push({method:'PATCH',destination,body:structuredClone(body),etag});return structuredClone(event)},
  delete:(destination,id,etag)=>{const k=key(destination,id),current=events.get(k);
   if(!current||current.etag!==etag)throw Object.assign(new Error('conflict'),{code:'REMOTE_CONFLICT'});
   // Model Google Calendar: API delete moves the event to trash (status
   // cancelled, still get-able by id) rather than purging it.
   events.set(k,{...current,status:'cancelled'});writes.push({method:'DELETE',destination,etag})},
  restore:(destination,body,etag)=>{const k=key(destination,body.id),current=events.get(k);
   if(!current||current.etag!==etag)throw Object.assign(new Error('conflict'),{code:'REMOTE_CONFLICT'});
   if(current.status!=='cancelled')throw Object.assign(new Error('not cancelled'),{code:'REMOTE_CONFLICT'});
   const event:CalendarEvent={...structuredClone(body),etag:'"2"'};events.set(k,event);writes.push({method:'POST',destination,body:structuredClone(body)});return structuredClone(event)}
 };
 return {port,events,writes};
}
function source(connectionId:string,index:number,extraText=''):SourceItem{
 return {connectionId,id:'m'+index,type:'gmail',title:'Submit lab report '+index,text:'Please submit your lab report '+index+' by 2026-11-02'+(extraText?' '+extraText:''),receivedAt:clock.iso(),updatedAt:clock.iso(),sender:'Lecturer <teacher@example.com>',threadId:'t'+index,rfcMessageId:'<m'+index+'@example.com>'};
}
interface ReconcileEnv{store:MemoryRecordStore;service:AppService;fake:ReturnType<typeof fakeCalendarPort>;connection:ConnectionView;tasks:TaskService;serviceIds:ReturnType<typeof hexIds>}
function reconcileFixture():ReconcileEnv{
 const store=new MemoryRecordStore(clock);
 const broker=fakeBroker();const fake=fakeCalendarPort();const serviceIds=hexIds();
 // The reconcile stage only runs after a completed round; seed automation on
 // so runScheduledSync() drives the full round + reconcile stage.
 store.put('settings','owner',{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90},null);
 const service=new AppService({owner,store,clock,ids:serviceIds,codec,http,broker,calendars:fake.port,syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:0})}});
 return {store,service,fake,connection:connect(broker),tasks:new TaskService(store,clock,serviceIds),serviceIds};
}
function saveRule(env:ReconcileEnv,ruleId:string,version:number,conditions:{sender?:string;keyword?:string;courseId?:string},decision:{mode:'automatic'|'review'|'ignore';destinations:{connectionId:string;calendarId:string}[]},priority=0){
 return okValue(env.service.handle(actor,{type:'route.save',requestId:'rule-'+ruleId+'-'+version,payload:{rule:{...(version>0?{id:ruleId}:{}) ,label:'Rule '+ruleId+' v'+version,sourceConnectionIds:[env.connection.id],priority,enabled:true,conditions,decision},...(version>0?{version}:{})}}));
}
function seedRoutedTask(env:ReconcileEnv,index:number,extraText=''):Task|null{
 const item=source(env.connection.id,index,extraText);
 env.store.put('sources','gmail:'+env.connection.id+':m'+index,item,null);
 return env.tasks.importSource(item);
}
// The reconcile stage runs after a COMPLETED sync round. Driving it through
// runScheduledSync() (the same stage the trigger uses) avoids the durable
// 15-second manual-sync throttle, which would otherwise gate out every pass
// after the first — the throttle itself is covered by app-service tests.
function syncNow(env:ReconcileEnv,requestId:string){void requestId;return env.service.runScheduledSync()}
function posts(fake:ReturnType<typeof fakeCalendarPort>){return fake.writes.filter(w=>w.method==='POST')}
function deletes(fake:ReturnType<typeof fakeCalendarPort>){return fake.writes.filter(w=>w.method==='DELETE')}
const primary=(env:ReconcileEnv)=>({connectionId:env.connection.id,calendarId:env.connection.id+'-calendar'});
const secondary=(env:ReconcileEnv)=>({connectionId:env.connection.id,calendarId:env.connection.id+'-calendar-2'});

it('fairRotationEventuallyConsidersEveryTask',()=>{
 const env=reconcileFixture();
 saveRule(env,'rule-1',0,{},{mode:'automatic',destinations:[primary(env)]});
 const created=Array.from({length:12},(_,i)=>seedRoutedTask(env,i+1)!);
 syncNow(env,'pass-1');
 expect(posts(env.fake)).toHaveLength(10); // bounded pass
 // The second pass must consider the two still-waiting tasks instead of
 // re-slicing the same first ten.
 syncNow(env,'pass-2');
 const linked=new Set(env.store.list<{taskId:string}>('calendar_link').map(r=>r.data.taskId));
 expect(posts(env.fake)).toHaveLength(12); // RED today: stays 10 — the last two are deferred forever
 for(const task of created)expect(linked.has(task.id)).toBe(true);
 // Restart safety: a new service instance over the same store must not duplicate or lose events.
 const restarted=new AppService({owner,store:env.store,clock,ids:hexIds(),codec,http,broker:fakeBroker(),calendars:env.fake.port,syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:0})}});
 restarted.handle(actor,{type:'sync.now',requestId:'pass-3',payload:{}});
 expect(posts(env.fake)).toHaveLength(12);
 expect(env.store.list<{taskId:string}>('calendar_link')).toHaveLength(12);
});

it('executionRoutingMatchesPreviewIncludingSources',()=>{
 const env=reconcileFixture();
 const task=seedRoutedTask(env,1,'containing the secret-phrase in the body')!;
 // The sender rule outranks the keyword rule; the keyword only exists in the stored source text.
 saveRule(env,'rule-sender',0,{sender:'Lecturer <teacher@example.com>'},{mode:'automatic',destinations:[primary(env)]},10);
 saveRule(env,'rule-keyword',0,{keyword:'secret-phrase'},{mode:'automatic',destinations:[secondary(env)]},5);
 const stored=env.store.get<Task>('tasks',task.id)!.data;
 const preview=new RoutingService(env.store,clock,hexIds(),env.fake.port).preview(stored);
 expect(preview.decision.mode).toBe('automatic');
 expect(preview.decision.destinations[0].calendarId).toBe(env.connection.id+'-calendar'); // sender rule wins in preview
 syncNow(env,'pass-1');
 const inserts=posts(env.fake);
 expect(inserts).toHaveLength(1); // RED today: 0 — sender rules can never match without source records
 expect(inserts[0].body?.id).toBe(managedEventId(task.id,preview.decision.destinations[0],env.serviceIds));
 expect(inserts[0].destination?.calendarId).toBe(preview.decision.destinations[0].calendarId);
});

it('orphanedLinksAreCleanedUpAfterTaskMerge',()=>{
 // task-service.importSource merges duplicates and removes the loser row; the
 // loser's calendar link and remote event must still be reconciled (cleanup
 // needs no task row — ownership comes from the link row).
 const env=reconcileFixture();
 const task=seedRoutedTask(env,1)!;
 saveRule(env,'rule-1',0,{},{mode:'automatic',destinations:[primary(env)]});
 syncNow(env,'create');
 expect(posts(env.fake)).toHaveLength(1);
 // Simulate the merge loser removal (the exact store effect of importSource).
 const row=env.store.get<{version:number}>('tasks',task.id)!;
 env.store.remove('tasks',task.id,row.version);
 syncNow(env,'cleanup');
 expect(deletes(env.fake)).toHaveLength(1); // remote event removed
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===task.id)).toBe(false);
 expect(env.store.list<{status:string}>('calendar_operation').every(r=>r.data.status==='complete')).toBe(true);
});

it('manualUserDeletionOfAnOpenTaskEventStaysInConflict',()=>{
 // The user deletes the managed event directly in Google Calendar: the event
 // moves to trash (cancelled) but the link row remains — OrbitDesk must not
 // silently recreate over the user's deletion (link row present = external
 // deletion; restore-in-place fires only when OrbitDesk's own cleanup
 // removed the link).
 const env=reconcileFixture();
 const task=seedRoutedTask(env,1)!;
 saveRule(env,'rule-1',0,{},{mode:'automatic',destinations:[primary(env)]});
 syncNow(env,'create');
 expect(posts(env.fake)).toHaveLength(1);
 const linkId=managedEventId(task.id,primary(env),env.serviceIds);
 const link=env.store.get<{eventId:string}>('calendar_link',linkId)!;
 const eventKey=primary(env).connectionId+'|'+primary(env).calendarId+'|'+link.data.eventId;
 const event=env.fake.events.get(eventKey)!;
 env.fake.events.set(eventKey,{...event,status:'cancelled'}); // user trash, ownership metadata intact
 syncNow(env,'user-deleted');
 expect(env.fake.writes.filter(w=>w.method==='POST').length).toBe(1); // no recreation after the user's deletion (the fake logs restores as POST too)
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===task.id)).toBe(true); // link intact
 const reconcileRow=env.store.list<{kind:string;message:string}>('activity').filter(r=>r.data.kind==='reconcile')[1]!;
 expect(reconcileRow.data.message).toContain('1 conflicts');
 expect(reconcileRow.data.message).toContain('deleted elsewhere');
});

it('linkedQuarantinedTaskIsPausedNotCleaned',()=>{
 // A task that still owns a link but is quarantined (importedUnreviewed via a
 // bundle import) is paused: no writes, no per-pass conflict noise, and it is
 // never mistaken for an orphaned link.
 const env=reconcileFixture();
 const task=seedRoutedTask(env,1)!;
 saveRule(env,'rule-1',0,{},{mode:'automatic',destinations:[primary(env)]});
 syncNow(env,'create');
 expect(posts(env.fake)).toHaveLength(1);
 const row=env.store.get<{version:number;data:Task}>('tasks',task.id)!;
 env.store.put('tasks',task.id,{...row.data,importedUnreviewed:true},row.version);
 syncNow(env,'paused');
 expect(env.fake.writes.length).toBe(1); // no further writes (pause is not removal)
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===task.id)).toBe(true); // link intact
 const activity=env.store.list<{kind:string;message:string}>('activity').filter(r=>r.data.kind==='reconcile')[1]!;
 expect(activity.data.message).toContain('0 needing attention'); // no recurring conflict noise
});

it('leaseReleaseHonorsTheHolderToken',()=>{
 // Two service instances share one store (two executions, one workspace) and
 // one id generator — production uses UUIDs, so per-execution counters would
 // collide on activity row ids.
 const store=new MemoryRecordStore(clock);
 store.put('settings','owner',{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90},null);
 const sharedIds=hexIds();
 const build=()=>new AppService({owner,store,clock,ids:sharedIds,codec,http,broker:fakeBroker(),calendars:fakeCalendarPort().port,syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:0})}});
 const first=build(),second=build();
 // A live lease held by another execution must survive a skipped pass: the
 // reconcile stage returns without releasing someone else's lease.
 store.put<{expires:number;token?:string}>('reconcile_lease','owner',{expires:Date.parse('2026-11-01T00:09:00Z'),token:'other-execution'},null);
 expect(first.runScheduledSync()).toMatchObject({status:'ok'}); // round runs; reconcile skipped (lease busy)
 expect(store.get<{expires:number;token?:string}>('reconcile_lease','owner')!.data.token).toBe('other-execution');
 // An expired leftover lease (crashed pass) is replaced by a fresh holder,
 // whose release removes only its own lease.
 const leftover=store.get<{expires:number;token?:string}>('reconcile_lease','owner')!;
 store.put<{expires:number;token?:string}>('reconcile_lease','owner',{expires:Date.parse('2026-11-01T00:00:00Z')-1,token:'crashed-pass'},leftover.version);
 expect(second.runScheduledSync()).toMatchObject({status:'ok'});
 expect(store.get<{expires:number;token?:string}>('reconcile_lease','owner')).toBeNull();
});

it('managedEventLifecycleTransitions',()=>{
 const env=reconcileFixture();
 const taskA=seedRoutedTask(env,1)!;
 const taskB=seedRoutedTask(env,2)!;
 saveRule(env,'rule-1',0,{},{mode:'automatic',destinations:[primary(env)]});
 syncNow(env,'initial');
 expect(posts(env.fake)).toHaveLength(2);
 const eventA=env.store.get<{taskId:string;eventId:string}>('calendar_link',managedEventId(taskA.id,primary(env),env.serviceIds))!.data.eventId;
 // (a) completion removes the obsolete managed event (ownership verified).
 const doneA=okValue<{version:number}>(env.service.handle(actor,{type:'task.complete',requestId:'done-a',payload:{id:taskA.id,version:1}}));
 syncNow(env,'after-complete');
 expect(deletes(env.fake)).toHaveLength(1); // RED today: 0 — completed tasks never reach the reconciler
 expect(env.fake.events.get(primary(env).connectionId+'|'+primary(env).calendarId+'|'+eventA)?.status).toBe('cancelled'); // trash model: deleted → cancelled; lookup uses the fake's composite key
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===taskA.id)).toBe(false);
 // (b) dismissal removes it too.
 okValue(env.service.handle(actor,{type:'task.dismiss',requestId:'dismiss-b',payload:{id:taskB.id,version:1}}));
 syncNow(env,'after-dismiss');
 expect(deletes(env.fake)).toHaveLength(2);
 // (c) restoration recreates the event on a later pass.
 okValue(env.service.handle(actor,{type:'task.restore',requestId:'restore-b',payload:{id:taskB.id,version:2}}));
 syncNow(env,'after-restore');
 expect(posts(env.fake)).toHaveLength(3); // RED today: no new POST — restored tasks are filtered out
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===taskB.id)).toBe(true);
 // (d) switching the task to an ignore override removes its event.
 const ignored=okValue<{version:number}>(env.service.handle(actor,{type:'task.update',requestId:'ignore-b',payload:{id:taskB.id,version:3,patch:{override:{mode:'ignore',destinations:[]}}}}));
 syncNow(env,'after-ignore');
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===taskB.id)).toBe(false); // RED today
 // (e) a review decision leaves the existing event untouched (pause is not removal).
 const taskC=seedRoutedTask(env,3)!;
 syncNow(env,'create-c');
 expect(env.store.list<{taskId:string}>('calendar_link').some(r=>r.data.taskId===taskC.id)).toBe(true);
 const reviewed=okValue<{version:number}>(env.service.handle(actor,{type:'task.update',requestId:'review-c',payload:{id:taskC.id,version:taskC.version,patch:{override:{mode:'review',destinations:[]}}}}));
 const writesBeforeReview=env.fake.writes.length;
 syncNow(env,'review-pin');
 expect(env.fake.writes.length).toBe(writesBeforeReview);
 // (f) a route change moves the event: old destination deleted, new created, exactly one link remains.
 okValue(env.service.handle(actor,{type:'task.update',requestId:'move-c',payload:{id:taskC.id,version:reviewed.version,patch:{override:{mode:'automatic',destinations:[secondary(env)]}}}}));
 syncNow(env,'move-c');
 const links=env.store.list<{taskId:string;destination:Destination}>('calendar_link').filter(r=>r.data.taskId===taskC.id);
 expect(links).toHaveLength(1);
 expect(links[0].data.destination.calendarId).toBe(env.connection.id+'-calendar-2'); // RED today: old event lingers
 void doneA; void ignored;
});
