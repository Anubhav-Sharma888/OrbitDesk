import {it,expect} from 'vitest';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {AppService,type AppServiceDeps} from '../../src/app/service.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {TaskService} from '../../src/tasks/task-service.js';
import {decideRoute} from '../../src/routing/rules.js';
import type {CalendarPort,CalendarEvent,ManagedCalendarEvent} from '../../src/providers/google-calendar.js';
import type {SyncPort} from '../../src/sync/scheduler.js';
import {AppError} from '../../src/shared/contracts.js';
import type {Codec,ConnectionView,Destination,RpcResponse,SecretStore,Task} from '../../src/shared/contracts.js';

const owner='owner@example.com';
const actor={kind:'user' as const,email:owner};
const clock={now:()=>Date.parse('2026-11-01T00:00:00Z'),iso:()=>'2026-11-01T00:00:00.000Z'};
// Narrows the RpcResponse union so value/state assertions stay type-checked.
function okValue<T=unknown>(result:RpcResponse):T {
 if(!result.ok)throw Error('expected ok response, got '+result.error.code+': '+result.error.message);
 return result.value as T;
}
function okState(result:RpcResponse){if(!result.ok)throw Error('expected ok response, got '+result.error.code+': '+result.error.message);return result.state}
// One shared id counter per fixture so two service instances never mint the same record id.
function ids(){let n=0;return {next:()=>'id'+(++n),hash:(v:string)=>v}}
const codec:Codec={encodeBase64Url:s=>Buffer.from(s).toString('base64url'),decodeBase64Url:s=>Buffer.from(s,'base64url').toString('utf8'),encodeBase64:s=>Buffer.from(s).toString('base64')};
const http={fetch:()=>({status:0,json:null})};
function fixture(overrides:Partial<AppServiceDeps>={}){
 const store=new MemoryRecordStore(clock);
 const generated=ids();
 const service=new AppService({owner,store,clock,ids:generated,codec,http,...overrides});
 return {store,service,ids:generated};
}
function fakeBroker(secrets:SecretStore=new MemorySecrets()):OAuthBroker {
 return new OAuthBroker({owner,secrets,clock,ids:ids(),factory:{service:()=>({
  authorizationUrl:()=>'https://accounts.google.com/o/oauth2/v2/auth?fixture=1',
  exchange:()=>true,
  identity:()=>({sub:'subject123',email:'student@example.com',emailVerified:true,scopes:['openid','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email']}),
  accessToken:()=>'fixture-access-value',
  reset:()=>{}
 })}});
}
function connectFixtureBroker(broker:OAuthBroker):ConnectionView {
 const pending=broker.beginConnection(owner,['mail.read']);
 return broker.completeConnection(owner,{pendingId:pending.pendingId,serviceName:pending.serviceName,code:'x'}).connection!;
}
// Full CalendarPort fake (stateful like the routing tests): one writable calendar
// per connection, deterministic etags, recorded writes, injectable update failure.
function fakeCalendarPort(){
 const events=new Map<string,CalendarEvent>();
 const writes:{method:string;body?:ManagedCalendarEvent;etag?:string}[]=[];
 let failUpdate=false;
 const key=(destination:Destination,id:string)=>destination.connectionId+'|'+destination.calendarId+'|'+id;
 const port:CalendarPort={
  listCalendars:(connectionId:string)=>[{connectionId,id:connectionId+'-calendar',summary:connectionId,accessRole:'writer',writable:true}],
  get:(destination,id)=>structuredClone(events.get(key(destination,id))??null),
  insert:(destination,body)=>{
   const k=key(destination,body.id);
   if(events.has(k))throw new AppError('ALREADY_EXISTS','A managed event already exists');
   const event:CalendarEvent={...structuredClone(body),etag:'"1"'};
   events.set(k,event);writes.push({method:'POST',body:structuredClone(body)});
   return structuredClone(event);
  },
  update:(destination,body,etag)=>{
   const k=key(destination,body.id),current=events.get(k);
   if(failUpdate||!current||current.etag!==etag)throw new AppError('REMOTE_CONFLICT','The managed calendar event changed elsewhere');
   const event:CalendarEvent={...structuredClone(body),etag:'"2"'};
   events.set(k,event);writes.push({method:'PATCH',body:structuredClone(body),etag});
   return structuredClone(event);
  },
  delete:(destination,id,etag)=>{
   const k=key(destination,id),current=events.get(k);
   if(!current||current.etag!==etag)throw new AppError('REMOTE_CONFLICT','The managed calendar event changed elsewhere');
   events.delete(k);writes.push({method:'DELETE',etag});
  }
 };
 return {port,events,writes,setFailUpdate:(value:boolean)=>{failUpdate=value}};
}
// The reconciler's deterministic IDs require a hex hash.
function hexIds(){let n=0;return {next:()=>'id'+(++n),hash:(v:string)=>Buffer.from(v).toString('hex')}}
function gmailSource(){return {connectionId:'a',id:'m1',type:'gmail' as const,title:'Assignment update',text:'Please submit by 2026-11-02',receivedAt:clock.iso(),updatedAt:clock.iso(),sender:'Lecturer <teacher@example.com>',threadId:'thread1',rfcMessageId:'<original@example.com>'}}
function createDraft(service:AppService,store:MemoryRecordStore):{id:string;version:number} {
 store.put('sources','gmail:a:m1',gmailSource(),null);
 return okValue(service.handle(actor,{type:'draft.create',requestId:'draft-0',payload:{sourceId:'m1',connectionId:'a',userContent:'I will submit tomorrow.'}}));
}

it('ownerGuardDerivesActorFromServerAndRejectsImpersonation',()=>{
 const {store,service}=fixture();
 // Even when the payload claims the owner identity, a non-owner session actor is rejected.
 const result=service.handle({kind:'user',email:'other@example.com'},{type:'task.create',requestId:'r1',payload:{title:'Study',notes:'',due:{kind:'unknown'},email:owner,actor:{kind:'user',email:owner}}});
 expect(result.ok).toBe(false);
 if(!result.ok){expect(result.error.code).toBe('UNAUTHORIZED');expect(result.state).toBeUndefined()}
 expect(store.list('tasks')).toHaveLength(0);
 expect(store.list('activity')).toHaveLength(0);
 // Payload identity fields are never honored: even for the owner actor, a payload
 // that smuggles identity keys is rejected by strict fail-closed validation, and
 // only the clean payload creates the task.
 const smuggled=service.handle(actor,{type:'task.create',requestId:'r2',payload:{title:'Study',notes:'',due:{kind:'unknown'},actor:{kind:'user',email:'other@example.com'}}});
 expect(smuggled.ok).toBe(false);
 if(!smuggled.ok)expect(smuggled.error.code).toBe('INVALID_INPUT');
 expect(store.list('tasks')).toHaveLength(0);
 const ok=service.handle(actor,{type:'task.create',requestId:'r3',payload:{title:'Study',notes:'',due:{kind:'unknown'}}});
 expect(okState(ok).tasks).toHaveLength(1);
});

it('nonUserActorKindsRejected',()=>{
 const {store,service}=fixture();
 for(const kind of ['ai','source'] as const){
  const result=service.handle({kind,email:owner},{type:'task.create',requestId:'r1',payload:{title:'Study'}});
  expect(result.ok).toBe(false);
  if(!result.ok)expect(result.error.code).toBe('UNAUTHORIZED');
 }
 expect(store.list('tasks')).toHaveLength(0);
});

it('stateProjectionShowsSavedDataAcrossServiceInstances',()=>{
 const {store}=fixture();
 const generated=ids();
 const phone=new AppService({owner,store,clock,ids:generated,codec,http});
 const laptop=new AppService({owner,store,clock,ids:generated,codec,http});
 const created=phone.handle(actor,{type:'conversation.create',requestId:'c1',payload:{title:'Coursework plan'}});
 const conversationId=okValue<{id:string}>(created).id;
 phone.handle(actor,{type:'message.append',requestId:'m1',payload:{conversationId,text:'Plan my assignment week'}});
 laptop.handle(actor,{type:'task.create',requestId:'t1',payload:{title:'Submit lab report',notes:'By Friday',due:{kind:'date',date:'2026-11-02'}}});
 const state=okState(laptop.handle(actor,{type:'state.get',requestId:'s1',payload:{}}));
 expect(state.app).toMatchObject({mode:'live',owner,storageReady:true,aiConfigured:false,setupRequired:[]});
 expect(state.conversations.map(c=>c.title)).toEqual(['Coursework plan']);
 expect(state.messages.map(m=>m.text)).toEqual(['Plan my assignment week']);
 expect(state.tasks.map(t=>t.title)).toContain('Submit lab report');
 expect(state.settings).toMatchObject({automationEnabled:false,aiEnabled:false});
});

it('duplicateRequestIdAppendsTheMessageOnce',()=>{
 const {service}=fixture();
 const created=service.handle(actor,{type:'conversation.create',requestId:'c1',payload:{title:'Chat'}});
 const conversationId=okValue<{id:string}>(created).id;
 const first=okValue<{id:string}>(service.handle(actor,{type:'message.append',requestId:'same-1',payload:{conversationId,text:'Saved once'}}));
 const replay=okValue<{id:string}>(service.handle(actor,{type:'message.append',requestId:'same-1',payload:{conversationId,text:'Saved once'}}));
 expect(replay.id).toBe(first.id);
 expect(okState(service.handle(actor,{type:'state.get',requestId:'s1',payload:{}})).messages).toHaveLength(1);
});

it('staleDraftSaveIsRejectedWithConflictAndFailureReturnsState',()=>{
 const {store,service}=fixture();
 const draft=createDraft(service,store);
 const saved=service.handle(actor,{type:'draft.save',requestId:'d1',payload:{id:draft.id,version:draft.version,to:['teacher@example.com'],body:'I will submit tomorrow.',userContent:'I will submit tomorrow.'}});
 expect(saved.ok).toBe(true);
 // A save replayed against the pre-save version must fail and still return fresh state for the UI.
 const stale=service.handle(actor,{type:'draft.save',requestId:'d2',payload:{id:draft.id,version:draft.version,to:['teacher@example.com'],body:'A stale edit',userContent:'A stale edit'}});
 expect(stale.ok).toBe(false);
 if(!stale.ok){
  expect(stale.error.code).toBe('VERSION_CONFLICT');
  expect(stale.error.message).toMatch(/changed on another device/);
  expect(stale.state).toBeDefined();
  if(stale.state){
   expect(stale.state.drafts[0].body).toBe('I will submit tomorrow.');
   expect(stale.state.drafts[0].version).toBe(2);
  }
 }
 expect(store.list<any>('activity').some(r=>r.data.status==='blocked')).toBe(true);
});

it('draftSendRequiresTheExplicitInstructionAndDoesNotResendTheSameRequest',()=>{
 let sends=0;
 const {store,service}=fixture({sendPort:{send:()=>{sends++;return {id:'remote-1',threadId:'thread1'}}}});
 const draft=createDraft(service,store);
 const wrong=service.handle(actor,{type:'draft.send',requestId:'send-0',payload:{id:draft.id,version:1,instruction:'please send'}});
 expect(wrong.ok).toBe(false);
 if(!wrong.ok)expect(wrong.error.code).toBe('SEND_INSTRUCTION_REQUIRED');
 expect(sends).toBe(0);
 const first=okValue<{status:string}>(service.handle(actor,{type:'draft.send',requestId:'send-1',payload:{id:draft.id,version:1,instruction:'send'}}));
 expect(first.status).toBe('sent');
 const replay=okValue<{status:string}>(service.handle(actor,{type:'draft.send',requestId:'send-1',payload:{id:draft.id,version:1,instruction:'send'}}));
 expect(replay.status).toBe('sent');
 expect(sends).toBe(1);
});

it('draftSendFailsClosedWithoutASendPort',()=>{
 const {store,service}=fixture();
 const draft=createDraft(service,store);
 const result=service.handle(actor,{type:'draft.send',requestId:'send-1',payload:{id:draft.id,version:draft.version,instruction:'send'}});
 expect(result.ok).toBe(false);
 if(!result.ok)expect(result.error.code).toBe('SETUP_REQUIRED');
 expect(store.get<{status:string}>('drafts',draft.id)!.data.status).toBe('draft');
});

it('aiCannotBeEnabledWithoutExplicitConsent',()=>{
 const {service}=fixture();
 const result=service.handle(actor,{type:'settings.save',requestId:'s1',payload:{settings:{timeZone:'Asia/Kolkata',automationEnabled:false,aiEnabled:true,aiConsent:false,accountDefaults:{},retentionDays:90}}});
 expect(result.ok).toBe(false);
 if(!result.ok){expect(result.error.code).toBe('INVALID_INPUT');expect(result.state?.settings.aiEnabled).toBe(false)}
 const allowed=okState(service.handle(actor,{type:'settings.save',requestId:'s2',payload:{settings:{timeZone:'Asia/Kolkata',automationEnabled:false,aiEnabled:true,aiConsent:true,accountDefaults:{},retentionDays:90}}}));
 expect(allowed.settings.retentionDays).toBe(90);
});

it('routeSaveAndPreviewReturnDecisionInfoWithoutCreatingEvents',()=>{
 const {service}=fixture({calendars:fakeCalendarPort().port});
 const rule={id:'rule-1',label:'Coursework to calendar',sourceConnectionIds:['a'],priority:10,enabled:true,conditions:{},decision:{mode:'automatic' as const,destinations:[{connectionId:'a',calendarId:'a-calendar'}]}};
 const saved=okValue<{version:number}>(service.handle(actor,{type:'route.save',requestId:'r1',payload:{rule}}));
 expect(saved.version).toBe(1);
 const preview=okValue<{decision:unknown;errors:string[];reason:string}>(service.handle(actor,{type:'route.preview',requestId:'r2',payload:{rule}}));
 expect(preview.decision).toEqual(rule.decision);
 expect(preview.errors).toEqual([]);
 expect(preview.reason).toBe('Item override');
});

it('scheduledSyncHonorsAutomationEnabledDefaultOff',()=>{
 let pages=0;
 const syncPort:SyncPort={page:()=>{pages++;return {checkpoint:null,done:true,consumedCalls:1,items:2}}};
 const broker=fakeBroker();
 const {service}=fixture({syncPort,broker});
 expect(service.runScheduledSync()).toEqual({status:'disabled',pages:0,items:0});
 expect(pages).toBe(0);
 connectFixtureBroker(broker);
 service.handle(actor,{type:'settings.save',requestId:'set-1',payload:{settings:{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90}}});
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:2});
 expect(pages).toBe(1);
});

it('syncNowRunsBoundedManualRoundAndRespectsTheManualThrottle',()=>{
 let pages=0;
 const syncPort:SyncPort={page:()=>{pages++;return {checkpoint:null,done:true,consumedCalls:1,items:2}}};
 const broker=fakeBroker();
 connectFixtureBroker(broker);
 const {service}=fixture({syncPort,broker});
 const first=okValue<{status:string;pages:number;items:number}>(service.handle(actor,{type:'sync.now',requestId:'sync-1',payload:{}}));
 expect(first).toMatchObject({status:'ok',pages:1,items:2});
 const state=okState(service.handle(actor,{type:'state.get',requestId:'s1',payload:{}}));
 expect(state.activity[0]?.kind).toBe('sync.now');
 const second=okValue<{status:string;pages:number}>(service.handle(actor,{type:'sync.now',requestId:'sync-2',payload:{}}));
 expect(second).toMatchObject({status:'throttled',pages:0});
 expect(pages).toBe(1);
});

it('stateProjectsLastSyncOnlyFromFullyCompletedImports',()=>{
 const broker=fakeBroker();
 const {store,service}=fixture({broker});
 const connection=connectFixtureBroker(broker);
 // No syncPort dependency exists, so this projection can only read stored rows.
 let query=0;
 const accountView=()=>okState(service.handle(actor,{type:'state.get',requestId:'q'+(++query),payload:{}})).accounts.find(a=>a.id===connection.id)!;
 // Nothing attempted yet: no lastSync.
 expect(accountView().lastSync).toBeUndefined();
 // An unfinished attempt (checkpoint advanced, no completed import) never looks fresh.
 const attempt={checkpoint:'page-2',failures:0,lastAttemptAt:clock.iso()};
 const attemptRow=store.put('sync_accounts',connection.id,attempt,null);
 expect(accountView().lastSync).toBeUndefined();
 // Only the last fully completed import sets lastSync.
 store.put('sync_accounts',connection.id,{...attempt,lastSuccessAt:clock.iso()},attemptRow.version);
 expect(accountView().lastSync).toBe(clock.iso());
 // A later failed attempt keeps the old completed time (the scheduler preserves
 // lastSuccessAt on failure) and surfaces the health error on the account.
 store.put('sync_accounts',connection.id,{checkpoint:null,failures:1,lastAttemptAt:clock.iso(),lastSuccessAt:clock.iso(),nextAttemptAt:clock.now()+120000,error:'This account needs a later sync attempt'},attemptRow.version+1);
 const afterFailure=accountView();
 expect(afterFailure.lastSync).toBe(clock.iso());
 expect(afterFailure.error).toBe('This account needs a later sync attempt');
});

it('setupChecksGateStorageReadyAndSetupRequired',()=>{
 const {service}=fixture({setupChecks:()=>['Google sign-in credentials are missing from restricted script properties']});
 const state=okState(service.handle(actor,{type:'state.get',requestId:'s1',payload:{}}));
 expect(state.app.setupRequired).toEqual(['Google sign-in credentials are missing from restricted script properties']);
 expect(state.app.storageReady).toBe(false);
 // The workspace itself still serves saved data while setup is pending.
 expect(state.settings.automationEnabled).toBe(false);
 // A setup probe that fails (e.g. storage not configured) is reported, not crashed.
 const failing=fixture({setupChecks:()=>{throw new AppError('SETUP_REQUIRED','Set the STORAGE_SPREADSHEET_ID script property to the private OrbitDesk spreadsheet')}});
 const reported=okState(failing.service.handle(actor,{type:'state.get',requestId:'s2',payload:{}}));
 expect(reported.app.storageReady).toBe(false);
 expect(reported.app.setupRequired).toEqual(['Set the STORAGE_SPREADSHEET_ID script property to the private OrbitDesk spreadsheet']);
});

it('clearOverrideUnsetsTheOverrideAndFallsBackToRuleRouting',()=>{
 const {store,service,ids:generated}=fixture({calendars:fakeCalendarPort().port});
 // A source-backed task so a saved rule can match it after the override is cleared.
 const imported=new TaskService(store,clock,generated).importSource({connectionId:'a',id:'m1',type:'gmail',title:'Submit lab report',text:'Please submit your lab report by 2026-11-02',receivedAt:clock.iso(),updatedAt:clock.iso(),sender:'Lecturer <teacher@example.com>',threadId:'t1',rfcMessageId:'<m1@example.com>'})!;
 // Force review through an override, then clear it with override:null.
 const forced=okValue<Task>(service.handle(actor,{type:'task.update',requestId:'o1',payload:{id:imported.id,version:imported.version,patch:{override:{mode:'review',destinations:[]}}}}));
 expect(forced.override).toMatchObject({mode:'review'});
 const cleared=okValue<Task>(service.handle(actor,{type:'task.update',requestId:'o2',payload:{id:imported.id,version:forced.version,patch:{override:null}}}));
 expect(cleared.override).toBeUndefined();
 const state=okState(service.handle(actor,{type:'state.get',requestId:'o3',payload:{}}));
 const savedTask=state.tasks.find(t=>t.id===imported.id)!;
 expect(savedTask.override).toBeUndefined();
 // Routing no longer honors a forced review: the matching saved rule decides.
 const decision=decideRoute(savedTask,{rules:[{id:'rule-1',version:1,label:'To calendar',sourceConnectionIds:['a'],priority:0,enabled:true,conditions:{},decision:{mode:'automatic',destinations:[{connectionId:'a',calendarId:'a-calendar'}]}}]});
 expect(decision.decision).toEqual({mode:'automatic',destinations:[{connectionId:'a',calendarId:'a-calendar'}]});
 expect(decision.reason).toBe('Matching rule');
 // CAS stays intact: the pre-clear version can no longer mutate the task.
 const stale=service.handle(actor,{type:'task.update',requestId:'o4',payload:{id:imported.id,version:forced.version,patch:{override:null}}});
 expect(stale.ok).toBe(false);
 if(!stale.ok)expect(stale.error.code).toBe('VERSION_CONFLICT');
});

it('clearOverrideOnTaskWithoutOverrideIsANoOp',()=>{
 const {service}=fixture();
 const created=okValue<Task>(service.handle(actor,{type:'task.create',requestId:'n0',payload:{title:'Personal errand',notes:'',due:{kind:'unknown'}}}));
 const result=okValue<Task>(service.handle(actor,{type:'task.update',requestId:'n1',payload:{id:created.id,version:created.version,patch:{override:null}}}));
 expect(result.override).toBeUndefined();
 expect(result.version).toBe(created.version+1);
 const stale=service.handle(actor,{type:'task.update',requestId:'n2',payload:{id:created.id,version:created.version,patch:{title:'Renamed'}}});
 expect(stale.ok).toBe(false);
 if(!stale.ok)expect(stale.error.code).toBe('VERSION_CONFLICT');
});

it('invalidOverrideShapeIsStillRejected',()=>{
 const {service}=fixture();
 const created=okValue<Task>(service.handle(actor,{type:'task.create',requestId:'v0',payload:{title:'Study',notes:'',due:{kind:'unknown'}}}));
 const badMode=service.handle(actor,{type:'task.update',requestId:'v1',payload:{id:created.id,version:created.version,patch:{override:{mode:'delete-everything'}}}});
 expect(badMode.ok).toBe(false);
 if(!badMode.ok)expect(badMode.error.code).toBe('INVALID_INPUT');
 const missingDestinations=service.handle(actor,{type:'task.update',requestId:'v2',payload:{id:created.id,version:created.version,patch:{override:{mode:'automatic'}}}});
 expect(missingDestinations.ok).toBe(false);
 if(!missingDestinations.ok)expect(missingDestinations.error.code).toBe('INVALID_INPUT');
 // Rejected patches never reach the store.
 const state=okState(service.handle(actor,{type:'state.get',requestId:'v3',payload:{}}));
 expect(state.tasks.find(t=>t.id===created.id)!.version).toBe(1);
});

it('disconnectRevokesTokenAccessAndStopsPollingForThatConnection',()=>{
 const resets:string[]=[];
 const secrets=new MemorySecrets();
 // Each service name is bound to its own verified Google identity.
 const subs=new Map<string,string>();
 const factory={service:(name:string)=>{
  if(!subs.has(name))subs.set(name,'sub'+subs.size);
  const sub=subs.get(name)!;
  return {
   authorizationUrl:()=>'https://accounts.google.com/o/oauth2/v2/auth?fixture=1',
   exchange:()=>true,
   identity:()=>({sub,email:sub+'@example.com',emailVerified:true,scopes:['openid','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email']}),
   accessToken:()=>'access-value-'+sub,
   reset:()=>{resets.push(name)}
  }}};
 const broker=new OAuthBroker({owner,secrets,clock,ids:ids(),factory});
 const connect=()=>{
  const pending=broker.beginConnection(owner,['mail.read']);
  return {pending,connection:broker.completeConnection(owner,{pendingId:pending.pendingId,serviceName:pending.serviceName,code:'x'}).connection!};
 };
 const a=connect(),b=connect();
 const paged:string[]=[];
 const {service}=fixture({broker,syncPort:{page:(connectionId)=>{paged.push(connectionId);return {checkpoint:null,done:true,consumedCalls:1,items:1}}}});
 // RPC-level disconnect of account A only.
 const disconnected=service.handle(actor,{type:'account.disconnect',requestId:'d1',payload:{id:a.connection.id}});
 expect(disconnected.ok).toBe(true);
 // (b) the status view shows the connection revoked and its token access is gone;
 // the other account keeps working.
 const view=okState(service.handle(actor,{type:'state.get',requestId:'d2',payload:{}})).accounts.find(x=>x.id===a.connection.id)!;
 expect(view).toMatchObject({status:'disconnected',paused:true,capabilities:[]});
 expect(()=>broker.access(a.connection.id,'mail.read')).toThrowError('Connection is not available');
 expect(broker.access(b.connection.id,'mail.read')).toBe('access-value-sub1');
 expect(resets).toContain(a.pending.serviceName);
 // (a) a subsequent scheduler round never polls the disconnected connection id.
 service.handle(actor,{type:'settings.save',requestId:'d3',payload:{settings:{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90}}});
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 expect(paged).toEqual([b.connection.id]);
});

// Shared setup for the bounded post-sync reconcile stage tests: one connected
// account, a writable simulated calendar, a no-op sync page, hex ids (the
// reconciler's deterministic IDs need a hex hash).
function reconcileFixture(){
 const broker=fakeBroker();
 const fake=fakeCalendarPort();
 const store=new MemoryRecordStore(clock);
 const serviceIds=hexIds();
 const service=new AppService({owner,store,clock,ids:serviceIds,codec,http,broker,calendars:fake.port,syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:1})}});
 return {store,service,fake,connection:connectFixtureBroker(broker),tasks:new TaskService(store,clock,serviceIds)};
}
function reconcileMail(connectionId:string,index:number){return {connectionId,id:'m'+index,type:'gmail' as const,title:'Submit lab report '+index,text:'Please submit your lab report '+index+' by 2026-11-02',receivedAt:clock.iso(),updatedAt:clock.iso(),sender:'Lecturer <teacher@example.com>',threadId:'t'+index,rfcMessageId:'<m'+index+'@example.com>'}}
function saveReconcileRule(service:AppService,connectionId:string,mode:'automatic'|'review'){
 return okValue(service.handle(actor,{type:'route.save',requestId:'rule',payload:{rule:{label:mode==='automatic'?'Coursework to calendar':'Review coursework',sourceConnectionIds:[connectionId],priority:0,enabled:true,conditions:{},decision:{mode,destinations:mode==='automatic'?[{connectionId,calendarId:connectionId+'-calendar'}]:[]}}}}));
}
function enableAutomation(service:AppService,requestId:string){
 service.handle(actor,{type:'settings.save',requestId,payload:{settings:{timeZone:'Asia/Kolkata',automationEnabled:true,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90}}});
}

it('syncNowReconcilesAutomaticRoutesIntoManagedCalendarEvents',()=>{
 const {service,fake,connection,tasks}=reconcileFixture();
 const imported=tasks.importSource(reconcileMail(connection.id,1))!;
 saveReconcileRule(service,connection.id,'automatic');
 const response=service.handle(actor,{type:'sync.now',requestId:'y1',payload:{}});
 expect(response.ok).toBe(true);
 expect(okValue<{status:string}>(response).status).toBe('ok');
 expect(fake.writes).toHaveLength(1);
 expect(fake.writes[0].method).toBe('POST');
 expect(fake.writes[0].body!.summary).toBe('Submit lab report 1');
 const state=okState(service.handle(actor,{type:'state.get',requestId:'y2',payload:{}}));
 const row=state.activity.find(a=>a.kind==='reconcile')!;
 expect(row.status).toBe('success');
 expect(row.message).toContain('1 events');
 const event=[...fake.events.values()][0];
 expect(event.id).toMatch(/^od[a-f0-9]+$/);
 expect(event.extendedProperties!.private!.taskId).toBe(imported.id);
});

it('reviewModeDecisionsNeverWriteCalendarEvents',()=>{
 const {service,fake,connection,tasks}=reconcileFixture();
 tasks.importSource(reconcileMail(connection.id,1));
 saveReconcileRule(service,connection.id,'review');
 const response=service.handle(actor,{type:'sync.now',requestId:'y1',payload:{}});
 expect(response.ok).toBe(true);
 expect(fake.writes).toHaveLength(0);
 const row=okState(service.handle(actor,{type:'state.get',requestId:'y2',payload:{}})).activity.find(a=>a.kind==='reconcile')!;
 expect(row.status).toBe('success');
 expect(row.message).toContain('0 events');
 // Review-mode tasks are excluded from the bounded pass entirely: they are
 // never written and never consume pass slots (pause is not removal).
 expect(row.message).toContain('0 skipped');
});

it('importedUnreviewedTasksAreNeverReconciled',()=>{
 const {store,service,fake,connection,tasks}=reconcileFixture();
 const imported=tasks.importSource(reconcileMail(connection.id,1))!;
 const current=store.get<{importedUnreviewed?:boolean}>('tasks',imported.id)!;
 store.put('tasks',imported.id,{...current.data,importedUnreviewed:true},current.version);
 saveReconcileRule(service,connection.id,'automatic');
 const response=service.handle(actor,{type:'sync.now',requestId:'y1',payload:{}});
 expect(response.ok).toBe(true);
 expect(fake.writes).toHaveLength(0);
 const row=okState(service.handle(actor,{type:'state.get',requestId:'y2',payload:{}})).activity.find(a=>a.kind==='reconcile')!;
 expect(row.status).toBe('success');
 expect(row.message).toContain('0 events');
 expect(row.message).toContain('0 skipped'); // excluded before routing, not decision-skipped
});

it('reconcileConflictsAreContainedInTheActivitySummary',()=>{
 const {store,service,fake,connection,tasks}=reconcileFixture();
 const imported=tasks.importSource(reconcileMail(connection.id,1))!;
 saveReconcileRule(service,connection.id,'automatic');
 enableAutomation(service,'set1');
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 expect(fake.writes).toHaveLength(1);
 // Edit the task so the next pass must update the managed event, then make updates fail.
 const current=store.get<{version:number}>('tasks',imported.id)!;
 service.handle(actor,{type:'task.update',requestId:'u1',payload:{id:imported.id,version:current.version,patch:{title:'Revised title'}}});
 fake.setFailUpdate(true);
 // The sync result shape is untouched by the contained reconcile failure.
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 expect(fake.writes).toHaveLength(1); // no PATCH reached the calendar
 const rows=okState(service.handle(actor,{type:'state.get',requestId:'u2',payload:{}})).activity.filter(a=>a.kind==='reconcile');
 expect(rows).toHaveLength(2);
 expect(rows[1].status).toBe('blocked');
 expect(rows[1].message).toContain('1 conflicts');
 expect(rows[1].message).toContain('changed elsewhere');
 expect([...fake.events.values()][0].summary).toBe('Submit lab report 1'); // remote state untouched
});

it('reconcilePassIsBoundedAndRotatesFairly',()=>{
 const {service,fake,connection,tasks}=reconcileFixture();
 for(let i=1;i<=12;i++)tasks.importSource(reconcileMail(connection.id,i));
 saveReconcileRule(service,connection.id,'automatic');
 enableAutomation(service,'set1');
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 expect(fake.writes.filter(w=>w.method==='POST')).toHaveLength(10);
 const first=okState(service.handle(actor,{type:'state.get',requestId:'e1',payload:{}})).activity.filter(a=>a.kind==='reconcile')[0];
 expect(first.message).toContain('10 events');
 expect(first.message).toContain('2 deferred');
 // Fair rotation: the next pass starts after the last task the previous pass
 // processed, so the two deferred tasks are considered first (two new managed
 // events) while the window's other eight re-verify idempotently.
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 expect(fake.writes.filter(w=>w.method==='POST')).toHaveLength(12);
 const second=okState(service.handle(actor,{type:'state.get',requestId:'e2',payload:{}})).activity.filter(a=>a.kind==='reconcile')[1];
 expect(second.message).toContain('10 events'); // this pass's eventIds: 2 new + 8 re-verified
 expect(second.message).toContain('0 conflicts');
 expect(second.message).toContain('2 deferred');
});

it('reconcileStageNoOpsWithoutACalendarPort',()=>{
 const broker=fakeBroker();
 const {store,service,ids:generated}=fixture({broker,syncPort:{page:()=>({checkpoint:null,done:true,consumedCalls:1,items:1})}});
 const connection=connectFixtureBroker(broker);
 new TaskService(store,clock,generated).importSource(reconcileMail(connection.id,1));
 saveReconcileRule(service,connection.id,'automatic');
 enableAutomation(service,'set1');
 expect(service.runScheduledSync()).toEqual({status:'ok',pages:1,items:1});
 const row=okState(service.handle(actor,{type:'state.get',requestId:'f1',payload:{}})).activity.find(a=>a.kind==='reconcile')!;
 expect(row.status).toBe('blocked');
 expect(row.message).toContain('skipped');
});

it('corruptConnectionRowIsRemovedAndStateStillProjects',()=>{
 const secrets=new MemorySecrets();
 const broker=fakeBroker(secrets);
 secrets.set('connection:broken','{corrupt');
 const {service}=fixture({broker});
 connectFixtureBroker(broker);
 const state=okState(service.handle(actor,{type:'state.get',requestId:'cc1',payload:{}}));
 expect(state.accounts).toHaveLength(1);
 expect(secrets.get('connection:broken')).toBeNull();
});
