import {z} from 'zod';
import {AppError,type Activity,type CalendarView,type ChatMessage,type Clock,type Codec,type ConnectionView,type Due,type HttpPort,type Ids,type RecordStore,type ReplyDraft,type RpcResponse,type Settings,type SourceItem,type Task,type UiState} from '../shared/contracts.js';
import {TaskService} from '../tasks/task-service.js';
import {ConversationService} from '../conversations/conversations.js';
import {DraftService} from '../conversations/drafts.js';
import {ReplyService,type ReplySendPort} from '../replies/send.js';
import {RoutingService,decideRoute,normalizeDecision} from '../routing/rules.js';
import {CalendarReconciler} from '../routing/reconcile.js';
import {SyncScheduler,type SyncPort,type SyncRound} from '../sync/scheduler.js';
import {ExportService} from '../storage/exports.js';
import {GroqClient,type GroqConfiguration} from '../ai/groq.js';
import {AiProposalService} from '../ai/proposals.js';
import {sourceKey} from '../tasks/correlate.js';
import type {OAuthBroker} from '../accounts/oauth.js';
import type {CalendarPort} from '../providers/google-calendar.js';

// Central application service. The only trusted actor is the owner derived
// server-side (entrypoints pass the requireOwner() result); command payloads
// can never supply identity or instruction authority. Every state-changing
// command executes inside one RecordStore.atomic so request dedup, version
// checks and the activity row commit or roll back together — except
// draft.send, whose pending write must be durable BEFORE the Gmail call
// (operations.md), so ReplyService manages its own atomic boundaries.

export interface AppServiceDeps {
 owner:string;
 store:RecordStore;
 clock:Clock;
 ids:Ids;
 codec:Codec;
 http:HttpPort;
 broker?:OAuthBroker; // account connections; omitted => account commands fail closed
 sendPort?:ReplySendPort; // Gmail send port; omitted => draft.send fails closed with no pending write
 syncPort?:SyncPort; // bounded import pages; omitted => sync commands fail closed
 calendars?:Pick<CalendarPort,'listCalendars'>; // calendar list port for preview verification and cache refresh; the reconcile stage additionally requires a full writable port (writableCalendarPort guard)
 aiConfig?:(settings:Settings)=>GroqConfiguration|null; // derives Groq config (key/model stay in restricted Script Properties, never Sheets)
 setupChecks?:()=>string[]; // readiness seam (credentials, storage probe); a nonempty result sets app.setupRequired and app.storageReady=false
 mode?:'live'|'demo';
}

type ActivityDraft=Omit<Activity,'id'|'at'>;
interface Outcome {value?:unknown;activity?:ActivityDraft}
type Actor={kind:string;email:string};
// Structural mirror of the scheduler's 'sync_accounts' record (not exported by
// src/sync/scheduler.ts). lastSuccessAt exists only after a fully completed
// page; failures add nextAttemptAt/error while preserving lastSuccessAt.
interface SyncHealthRecord {checkpoint?:unknown;lastSuccessAt?:string;lastAttemptAt?:string;nextAttemptAt?:number;failures?:number;error?:string}

const requestIdPattern=/^[-A-Za-z0-9_:.]{1,128}$/;
const idPattern=/^[-A-Za-z0-9_:.]{1,300}$/;
const requestId=z.string().regex(requestIdPattern);
const recordId=z.string().regex(idPattern);
const due=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('unknown')}).strict(),
 z.object({kind:z.literal('date'),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),
 z.object({kind:z.literal('instant'),at:z.string().min(1).max(40),zone:z.string().min(1).max(100)}).strict()
]);
const decision=z.object({mode:z.enum(['automatic','review','ignore']),destinations:z.array(z.object({connectionId:z.string().min(1).max(150),calendarId:z.string().min(1).max(1024)}).strict()).max(9)}).strict();
const rule=z.object({
 id:recordId.or(z.literal('')).optional(),
 version:z.number().int().optional(),
 label:z.string().max(200),
 sourceConnectionIds:z.array(z.string().max(150)).max(9),
 priority:z.number(),
 enabled:z.boolean(),
 conditions:z.object({sender:z.string().max(500).optional(),courseId:z.string().max(300).optional(),keyword:z.string().max(500).optional()}).strict(),
 decision
}).strict();
const settings=z.object({
 timeZone:z.string().min(1).max(100),
 automationEnabled:z.boolean(),
 aiEnabled:z.boolean(),
 aiConsent:z.boolean(),
 accountDefaults:z.record(z.string().max(150),decision),
 retentionDays:z.number().int().min(1).max(3650)
}).strict();
const envelope=z.object({type:z.string().max(60),requestId,payload:z.record(z.string(),z.unknown())}).strict();
const commandSchemas:Record<string,z.ZodType>={
 'state.get':z.object({}).strict(),
 'sync.now':z.object({}).strict(),
 'task.create':z.object({title:z.string().max(500),notes:z.string().max(12000).optional(),due:due.optional(),plannedDue:due.optional()}).strict(),
 'task.update':z.object({id:recordId,version:z.number().int().positive(),patch:z.object({title:z.string().optional(),notes:z.string().optional(),officialDue:due.optional(),override:decision.nullable().optional(),plannedDue:z.union([due,z.null()]).optional()}).strict()}).strict(),
 'task.complete':z.object({id:recordId,version:z.number().int().positive()}).strict(),
 'task.dismiss':z.object({id:recordId,version:z.number().int().positive()}).strict(),
 'task.restore':z.object({id:recordId,version:z.number().int().positive()}).strict(),
 'conversation.create':z.object({title:z.string().max(200)}).strict(),
 'message.append':z.object({conversationId:recordId,text:z.string().max(12000)}).strict(),
 'draft.create':z.object({sourceId:recordId,connectionId:recordId,userContent:z.string().max(16000)}).strict(),
 'draft.save':z.object({id:recordId,version:z.number().int().positive(),to:z.array(z.string().max(254)).min(1).max(10),body:z.string().max(16000),userContent:z.string().max(16000)}).strict(),
 'draft.send':z.object({id:recordId,version:z.number().int().positive(),instruction:z.string().max(40)}).strict(),
 'draft.rephrase':z.object({id:recordId,version:z.number().int().positive(),tone:z.enum(['clear','friendly','formal']).optional()}).strict(),
 'account.connect':z.object({capabilities:z.array(z.enum(['mail.read','mail.send','calendar.list','calendar.read','calendar.write','classroom.read'])).min(1).max(9),email:z.string().max(254).optional(),workflow:z.enum(['manual','agent']).optional()}).strict(),
 'account.pause':z.object({id:recordId,paused:z.boolean()}).strict(),
 'account.disconnect':z.object({id:recordId}).strict(),
 'route.save':z.object({rule,version:z.number().int().min(0).optional()}).strict(),
 'route.preview':z.object({rule}).strict(),
 'settings.save':z.object({settings}).strict(),
 'export.create':z.object({}).strict(),
 'import.preview':z.object({bundle:z.unknown()}).strict(),
 'import.apply':z.object({previewId:recordId}).strict()
};
const labels:Record<string,string>={
 'rpc':'Request','state.get':'Workspace opened','sync.now':'Manual sync','scheduledSync':'Scheduled import',
 'task.create':'Task created','task.update':'Task updated','task.complete':'Task completed','task.dismiss':'Task dismissed','task.restore':'Task restored',
 'conversation.create':'Conversation created','message.append':'Message saved',
 'draft.create':'Reply draft created','draft.save':'Reply draft saved','draft.send':'Reply send','draft.rephrase':'AI rephrase proposed',
 'account.connect':'Google authorization started','account.pause':'Account pause changed','account.disconnect':'Account disconnected',
 'route.save':'Routing rule saved','route.preview':'Route previewed','settings.save':'Settings saved',
 'export.create':'Workspace exported','import.preview':'Import preview created','import.apply':'Reviewed import applied'
};
// Policy/validation/conflict rejections are 'blocked'; everything else is an operational 'error'.
const blockedCodes=new Set(['UNAUTHORIZED','INVALID_INPUT','INVALID_RECORD','INVALID_SOURCE','INVALID_DUE','INVALID_ROUTE','INVALID_IMPORT','INVALID_CAPABILITY','INVALID_EMAIL','INVALID_WORKFLOW','INVALID_CALLBACK','INVALID_HEADER','INVALID_CURSOR','NOT_FOUND','VERSION_CONFLICT','REMOTE_CONFLICT','DRAFT_LOCKED','SEND_INSTRUCTION_REQUIRED','USER_CONTENT_REQUIRED','REVIEW_REQUIRED','IDEMPOTENCY_CONFLICT','REQUEST_CONFLICT','STALE_PREVIEW','OFFICIAL_DUE_READ_ONLY','WRONG_IDENTITY','ACCOUNT_MISMATCH','WRONG_CALLBACK','STALE_CALLBACK','EXPIRED_CALLBACK','MANUAL_CONNECTION_REQUIRED','NO_CONNECTION','MISSING_PERMISSION','LINK_LIMIT','EXPORT_LIMIT','IMPORT_LIMIT','SYNC_CONTRACT','INVALID_BUDGET','UNKNOWN_COMMAND']);
// Bounded post-sync reconcile pass: at most this many eligible tasks per sync round.
const MAX_RECONCILE_TASKS=10;

function safeError(error:unknown):{code:string;message:string} {return error instanceof AppError?{code:error.code,message:error.message}:{code:'INTERNAL_ERROR',message:'The operation could not be completed'}}
function sendActivityStatus(status:ReplyDraft['status']):Activity['status'] {return status==='sent'?'success':status==='pending'?'pending':status==='unknown'?'unknown':status==='failed'?'error':'blocked'}
// The reconcile stage writes events, so it requires a full CalendarPort. A
// list-only port (calendar verification for previews, demo backends) fail-closes
// the stage: it can read calendars but can never write events.
function writableCalendarPort(port:Pick<CalendarPort,'listCalendars'>|undefined):CalendarPort|null {
 if(!port||typeof port!=='object')return null;
 const candidate=port as Partial<CalendarPort>;
 return typeof candidate.get==='function'&&typeof candidate.insert==='function'&&typeof candidate.update==='function'&&typeof candidate.delete==='function'?port as CalendarPort:null;
}

export class AppService {
 constructor(private deps:AppServiceDeps){}

 handle(actor:Actor,command:unknown):RpcResponse {
  // The actor is derived by the entrypoint from the authenticated session;
  // AI/source actors can never drive commands and payloads carry no identity.
  if(!this.trusted(actor))return {ok:false,error:{code:'UNAUTHORIZED',message:'Owner guard requires your signed-in owner account'}};
  const parsed=envelope.safeParse(command);
  if(!parsed.success)return this.failure('rpc','INVALID_INPUT','This request has invalid or missing fields');
  const type=parsed.data.type,requestId=parsed.data.requestId;
  const schema=commandSchemas[type];
  if(!schema)return this.failure(type,'UNKNOWN_COMMAND','This command is not supported');
  const payload=schema.safeParse(parsed.data.payload);
  if(!payload.success)return this.failure(type,'INVALID_INPUT','This request has invalid or missing fields');
  if(type==='state.get'){try{return {ok:true,state:this.getUiState()}}catch(e){return {ok:false,error:safeError(e)}}}
  try{
   if(type==='draft.send')return this.sendDraft(requestId,payload.data as {id:string;version:number;instruction:string});
   if(type==='sync.now')return this.manualSync();
   const outcome=this.deps.store.atomic(()=>{const result=this.dispatch(type,requestId,payload.data as Record<string,unknown>);if(result.activity)this.writeActivity(result.activity);return result});
   return {ok:true,state:this.getUiState(),value:outcome.value};
  }catch(e){
   const error=e instanceof AppError?e:new AppError('INTERNAL_ERROR','The operation could not be completed');
   this.failureActivity(type,error);
   let state:UiState|undefined;
   try{state=this.getUiState()}catch{/* storage unavailable; typed error is still returned */}
   return {ok:false,error:{code:error.code,message:error.message},...(state?{state}:{})};
  }
 }

 // Scheduled trigger round: automation stays off unless the owner enabled it
 // in settings; the whole bounded round runs inside one store.atomic so the
 // durable lease rejects overlapping executions.
 runScheduledSync():{status:string;pages:number;items:number} {
  try{
   const outcome=this.deps.store.atomic(()=>{const result=this.runSyncRound(false);if(result.activity)this.writeActivity(result.activity);return result});
   this.reconcileAfterSync(outcome.stopped);
   return {status:outcome.value.status,pages:outcome.value.pages,items:outcome.value.items};
  }catch(e){
   const error=e instanceof AppError?e:new AppError('INTERNAL_ERROR','The operation could not be completed');
   this.failureActivity('scheduledSync',error);
   if(error.code==='BUSY')return {status:'busy',pages:0,items:0};
   throw error;
  }
 }

 getUiState():UiState {
  const store=this.deps.store,settings=this.readSettings();
  const accounts=(this.deps.broker?this.deps.broker.listConnections(this.deps.owner):[]).map(account=>this.withSyncHealth(account));
  const calendars=store.list<CalendarView>('calendars').map(r=>r.data);
  const tasks=this.tasks.list();
  const conversations=store.list<{id:string;title:string;createdAt:string}>('conversations').map(r=>({...r.data,id:r.id,version:r.version,updatedAt:r.updatedAt}));
  const messages=store.list<ChatMessage>('messages').map(r=>r.data)
   .sort((a,b)=>a.createdAt===b.createdAt?(Number((a as {sequence?:number}).sequence??0)-Number((b as {sequence?:number}).sequence??0)):(a.createdAt<b.createdAt?-1:1));
  const drafts=store.list<ReplyDraft>('drafts').map(r=>({...r.data,id:r.id,version:r.version,updatedAt:r.updatedAt}));
  const routes=store.list<UiState['routes'][number]>('routes').map(r=>({...r.data,version:r.version}));
  const activity=store.list<{kind:string;message:string;status:Activity['status'];at?:string}>('activity')
   .map(r=>({...r.data,id:r.id,at:typeof r.data.at==='string'?r.data.at:r.updatedAt}))
   .sort((a,b)=>a.at===b.at?0:(a.at<b.at?-1:1)); // newest last, stable for identical timestamps
  const sources=store.list<SourceItem>('sources').map(r=>r.data);
  const config=this.deps.aiConfig?this.deps.aiConfig(settings):null;
  const aiConfigured=Boolean(config&&config.apiKey&&config.model&&config.freePlanConfirmed===true);
  let setupRequired:string[]=[];
  try{setupRequired=this.deps.setupChecks?this.deps.setupChecks():[]}
  catch(e){setupRequired=[e instanceof AppError?e.message:'Setup could not be verified']}
  // setupChecks is the readiness seam: a nonempty result (missing credentials, a
  // storage probe that fails, ...) marks the workspace setup-required and not ready.
  const storageReady=setupRequired.length===0;
  return {app:{mode:this.deps.mode??'live',owner:this.deps.owner,storageReady,aiConfigured,setupRequired},settings,accounts,calendars,tasks,conversations,messages,drafts,routes,activity,sources};
 }

 // Read-only health projection: each account's lastSync comes from the
 // SyncScheduler's stored 'sync_accounts' record, where lastSuccessAt is written
 // only after a fully completed import page, so an unfinished attempt never makes
 // an account look freshly synced (operations.md). A stored sync error/backoff is
 // surfaced on the account. Rows are read directly — the scheduler (which needs a
 // sync port) is never constructed during state projection.
 private withSyncHealth(account:ConnectionView):ConnectionView {
  const health=this.deps.store.get<SyncHealthRecord>('sync_accounts',account.id)?.data;
  if(!health)return account;
  return {...account,
   ...(typeof health.lastSuccessAt==='string'?{lastSync:health.lastSuccessAt}:{}),
   ...(typeof health.error==='string'&&health.error?{error:health.error}:{})
  };
 }

 private trusted(actor:Actor):boolean {
  const owner=this.deps.owner.trim().toLowerCase();
  return Boolean(owner)&&actor!==null&&typeof actor==='object'&&actor.kind==='user'&&typeof actor.email==='string'&&actor.email.trim().toLowerCase()===owner;
 }

 private dispatch(type:string,requestId:string,p:Record<string,unknown>):Outcome {
  const activity=(message:string,status:Activity['status']='success'):ActivityDraft=>({kind:type,message,status});
  switch(type){
   case 'task.create':return {value:this.tasks.create({title:p.title as string,notes:p.notes as string|undefined,officialDue:p.due as Task['officialDue']|undefined,plannedDue:p.plannedDue as Task['plannedDue']}),activity:activity('Task created')};
   case 'task.update':return {value:this.updateTask(p as {id:string;version:number;patch:Record<string,unknown>}),activity:activity('Task updated')};
   case 'task.complete':return {value:this.tasks.complete(p.id as string,p.version as number),activity:activity('Task marked complete. Coursework is not submitted.')};
   case 'task.dismiss':return {value:this.tasks.dismiss(p.id as string,p.version as number),activity:activity('Task dismissed')};
   case 'task.restore':return {value:this.tasks.restore(p.id as string,p.version as number),activity:activity('Task restored')};
   case 'conversation.create':return {value:this.conversations.create(p.title as string),activity:activity('Conversation created')};
   case 'message.append':return {value:this.conversations.append(p.conversationId as string,requestId,'user',p.text as string),activity:activity('Message saved')};
   case 'draft.create':{
    const row=this.deps.store.get<SourceItem>('sources',sourceKey({connectionId:p.connectionId as string,type:'gmail',id:p.sourceId as string}));
    if(!row)throw new AppError('NOT_FOUND','Import the Gmail message before replying to it');
    if(row.data.type!=='gmail')throw new AppError('INVALID_SOURCE','Choose a verified Gmail message with reply information');
    return {value:this.drafts.create(row.data,p.userContent as string),activity:activity('Reply draft created')};
   }
   case 'draft.save':return {value:this.drafts.save(p.id as string,p.version as number,{to:p.to as string[],body:p.body as string,userContent:p.userContent as string}),activity:activity('Reply draft saved')};
   case 'draft.rephrase':{
    const draft=this.drafts.get(p.id as string);
    if(draft.version!==p.version)throw new AppError('VERSION_CONFLICT','This item changed on another device');
    if(['pending','unknown','sent'].includes(draft.status))throw new AppError('DRAFT_LOCKED','This reply has been submitted; create a new draft');
    // The proposal never saves, sends or changes recipients; the user must save and send explicitly.
    return {value:this.ai().rephrase(draft),activity:activity('AI rephrase proposed')};
   }
   case 'account.connect':{
    const started=this.requireBroker().beginConnection(this.deps.owner,p.capabilities as never,typeof p.email==='string'&&p.email?p.email:undefined,p.workflow as 'manual'|'agent'|undefined??'manual');
    return {value:{pendingId:started.pendingId,serviceName:started.serviceName,authorizationUrl:started.authorizationUrl},activity:activity('Google authorization started')};
   }
   case 'account.pause':{
    const view=this.requireBroker().pause(this.deps.owner,p.id as string,p.paused as boolean);
    return {value:view,activity:activity(view.paused?'Account paused':'Account resumed')};
   }
   case 'account.disconnect':{
    const view=this.requireBroker().disconnect(this.deps.owner,p.id as string);
    this.removeCalendars(view.id);
    return {value:view,activity:activity('Account disconnected. Saved records are kept.')};
   }
   case 'route.save':{
    const expected=typeof p.version==='number'&&p.version>0?p.version as number:null;
    return {value:this.routing.saveRule(p.rule as Parameters<RoutingService['saveRule']>[0],expected),activity:activity('Routing rule saved')};
   }
   case 'route.preview':{
    // Read-only: evaluate the rule's decision and verify destination writability. No events are created.
    const preview=this.routing.preview(this.previewTask(p.rule as {label?:string;decision:Parameters<typeof normalizeDecision>[0]}));
    return {value:preview};
   }
   case 'settings.save':return {value:this.saveSettings(p.settings as Settings),activity:activity('Settings saved')};
   case 'export.create':{
    const bundle=this.exports.create();
    return {value:bundle,activity:activity('Workspace exported ('+bundle.records.length+' records, no credentials)')};
   }
   case 'import.preview':{
    const preview=this.exports.preview(p.bundle);
    return {value:preview,activity:activity('Import preview created ('+preview.count+' records)')};
   }
   case 'import.apply':{
    const applied=this.exports.apply(p.previewId as string);
    return {value:applied,activity:activity('Reviewed import applied ('+applied.count+' records; automation and AI stay off)')};
   }
   default:throw new AppError('UNKNOWN_COMMAND','This command is not supported');
  }
 }

 private updateTask(p:{id:string;version:number;patch:Record<string,unknown>}):Task {
  const patch=p.patch??{};
  const known=['title','notes','officialDue','override','plannedDue'];
  if(Object.keys(patch).some(k=>!known.includes(k)))throw new AppError('INVALID_INPUT','Unsupported task change');
  const editKeys=['title','notes','officialDue','override'].filter(k=>patch[k]!==undefined);
  if(!editKeys.length&&patch.plannedDue===undefined)throw new AppError('INVALID_INPUT','Choose a task change to save');
  let task:Task;
  if(editKeys.length){
   const edit:Record<string,unknown>={};
   for(const key of editKeys)edit[key]=patch[key];
   task=this.tasks.edit(p.id,p.version,edit as never);
  }else task=this.tasks.get(p.id);
  if(patch.plannedDue!==undefined)task=this.tasks.reschedule(p.id,task.version,patch.plannedDue as Due|null);
  return task;
 }

 private sendDraft(requestId:string,p:{id:string;version:number;instruction:string}):RpcResponse {
  // No outer store.atomic here: ReplyService makes the pending write durable,
  // releases the lock, performs the Gmail call, then records the outcome.
  const draft=this.replies.send({kind:'user',email:this.deps.owner},{requestId,draftId:p.id,expectedVersion:p.version,instruction:p.instruction});
  this.writeActivity({kind:'draft.send',message:'Reply send '+draft.status,status:sendActivityStatus(draft.status)});
  return {ok:true,state:this.getUiState(),value:draft};
 }

 private manualSync():RpcResponse {
  const outcome=this.deps.store.atomic(()=>{const result=this.runSyncRound(true);if(result.activity)this.writeActivity(result.activity);return result});
  this.refreshCalendars(); // best-effort calendar cache refresh after the round; failures never fail the sync
  this.reconcileAfterSync(outcome.stopped);
  return {ok:true,state:this.getUiState(),value:outcome.value};
 }

 private runSyncRound(manual:boolean):{value:{status:string;pages:number;items:number;calls:number};activity?:ActivityDraft;stopped:string} {
  const round=this.runScheduler(manual);
  const status=round.stopped==='complete'||round.stopped==='time'||round.stopped==='round'?'ok':round.stopped;
  // A trigger firing while automation is disabled records nothing, so a disabled
  // deployment with an installed trigger cannot flood the activity log.
  if(round.stopped==='disabled')return {value:{status,pages:0,items:0,calls:0},stopped:round.stopped};
  const message=(manual?'Manual sync ':'Scheduled import ')+round.stopped+': '+round.pages+' pages, '+round.items+' items';
  const statusKind:Activity['status']=round.pages>0?'success':['busy','throttled','budget'].includes(round.stopped)?'blocked':'success';
  return {value:{status,pages:round.pages,items:round.items,calls:round.calls},activity:{kind:manual?'sync.now':'scheduledSync',message,status:statusKind},stopped:round.stopped};
 }

 private runScheduler(manual:boolean):SyncRound {
  if(!this.deps.syncPort)throw new AppError('SETUP_REQUIRED','Import syncing is not configured in this environment');
  const settings=this.readSettings();
  if(!manual&&!settings.automationEnabled)return {pages:0,items:0,calls:0,stopped:'disabled'};
  if(manual&&!this.deps.broker)throw new AppError('SETUP_REQUIRED','Account connections are not configured in this environment');
  const connections=(this.deps.broker?this.deps.broker.listConnections(this.deps.owner):[])
   // A scheduled round polls through the background grant, so eligibility must
   // consider background capabilities too; the import bridge and
   // OAuthBroker.access re-validate the effective capabilities per request,
   // so this only widens who is polled, never what is fetched.
   .map(c=>manual?c:{...c,capabilities:[...new Set([...c.capabilities,...(c.backgroundCapabilities??[])])]});
  return this.scheduler.run(connections,manual?{manual:true}:{automationEnabled:settings.automationEnabled===true});
 }

 private refreshCalendars():void {
  const port=this.deps.calendars,broker=this.deps.broker;
  if(!port||!broker)return;
  const targets=broker.listConnections(this.deps.owner).filter(c=>c.status==='active'&&!c.paused&&c.capabilities.includes('calendar.list'));
  const succeeded=new Map<string,CalendarView[]>();
  for(const connection of targets)try{succeeded.set(connection.id,port.listCalendars(connection.id))}catch{/* unauthorized or unreachable: keep previous cache */}
  if(!succeeded.size)return;
  try{
   this.deps.store.atomic(()=>{
    for(const [connectionId,views] of succeeded){
     for(const row of this.deps.store.list<CalendarView>('calendars'))if(row.data.connectionId===connectionId&&!views.some(v=>v.id===row.data.id))this.deps.store.remove('calendars',row.id,row.version);
     for(const view of views){
      // Calendar IDs can contain characters the record-id pattern forbids, so the
      // row key uses a stable hash of the calendar ID.
      const id='cal:'+connectionId+':'+this.deps.ids.hash(view.id);
      const existing=this.deps.store.get('calendars',id);
      this.deps.store.put('calendars',id,{...view},existing?existing.version:null);
     }
    }
   });
  }catch{/* calendar cache is best-effort */}
 }

 private removeCalendars(connectionId:string):void {
  for(const row of this.deps.store.list<CalendarView>('calendars'))if(row.data.connectionId===connectionId)this.deps.store.remove('calendars',row.id,row.version);
 }

 // Bounded post-sync reconcile stage (operations.md). Pages never reconcile
 // (operations.md:9); this stage runs only after a sync round that finished its
 // pages ('complete' or 'time'), under a durable lease and with per-operation
 // durability: each pending-operation row is committed on its own BEFORE its
 // provider call and its outcome is recorded afterward, so an interruption
 // never leaves an unrecorded calendar mutation and recovery replays
 // idempotently (deterministic event IDs + remote state checks). It acts on
 // open tasks plus any task that still owns calendar links whose routing
 // decision is not 'review' — review leaves existing events untouched, while
 // complete/dismiss/ignore/route-change reconcile obsolete OrbitDesk-owned
 // mappings. Eligible tasks rotate fairly: a durable cursor starts each pass
 // after the last task the previous pass processed, so later tasks eventually
 // receive consideration even when older tasks stay open. LIVE CALENDAR
 // MUTATIONS remain gated by the human deployment checklist: the stage only
 // acts through the injected calendar port (live GoogleCalendar in production,
 // a simulated port in demo/local runs), and live writes may be enabled only
 // after the live checklist passes.
 private reconcileAfterSync(stopped:string):void {
  if(stopped!=='complete'&&stopped!=='time')return;
  try{
   if(!this.acquireReconcileLease())return;
   try{
    const entry=this.reconcilePass();
    if(entry)this.writeActivity(entry);
   }finally{this.releaseReconcileLease()}
  }catch{/* reconcile is best-effort; the sync result and its shape stand */}
 }

 // Coordination lease, deliberately NOT a storage transaction: it protects the
 // multi-step pass against overlapping executions while every data write
 // commits on its own (SheetRecordStore only flushes nested writes when the
 // outermost atomic ends, so nesting the pass would defer durability). The
 // lease carries a holder token so a pass that overruns its expiry cannot
 // delete the successor's lease on release.
 private reconcileLeaseToken='';
 private acquireReconcileLease():boolean {
  const token=this.deps.ids.next();
  const acquired=this.deps.store.atomic(()=>{
   const row=this.deps.store.get<{expires:number;token?:string}>('reconcile_lease','owner');
   if(row&&row.data.expires>this.deps.clock.now())return false;
   this.deps.store.put('reconcile_lease','owner',{expires:this.deps.clock.now()+600_000,token},row?.version??null);
   return true;
  });
  if(acquired)this.reconcileLeaseToken=token;
  return acquired;
 }
 private releaseReconcileLease():void {
  const token=this.reconcileLeaseToken;
  this.reconcileLeaseToken='';
  this.deps.store.atomic(()=>{
   const row=this.deps.store.get<{expires:number;token?:string}>('reconcile_lease','owner');
   if(row&&row.data.token===token)this.deps.store.remove('reconcile_lease','owner',row.version);
  });
 }

 private reconcilePass():ActivityDraft {
  const calendar=writableCalendarPort(this.deps.calendars);
  if(!calendar)return {kind:'reconcile',message:'Calendar reconcile skipped: no writable calendar port is configured in this environment',status:'blocked'};
  const settings=this.readSettings();
  const rules=this.deps.store.list<UiState['routes'][number]>('routes').map(r=>({...r.data,version:r.version}));
  // Routing execution must see the same account-scoped source records as
  // routing preview: sender conditions and source-text keywords are evaluated
  // against the stored sources, never guessed from titles alone.
  const sources=this.deps.store.list<UiState['sources'][number]>('sources').map(r=>r.data);
  const reconciler=new CalendarReconciler(this.deps.store,calendar,this.deps.clock,this.deps.ids);
  const linkedTasks=new Set(this.deps.store.list<{taskId:string}>('calendar_link').map(r=>r.data.taskId));
  const candidates=this.tasks.list()
   .filter(t=>!t.importedUnreviewed&&(t.status==='open'||linkedTasks.has(t.id)))
   .sort((a,b)=>a.createdAt===b.createdAt?(a.id<b.id?-1:1):(a.createdAt<b.createdAt?-1:1)); // oldest first
  // A task that disappeared while still owning calendar links (its import was
  // merged away into a duplicate, or its row was removed mid-pass) must not
  // strand its managed events: synthesize a cleanup candidate so the pass
  // removes the OrbitDesk-owned mappings exactly as it would for a dismissed
  // task. The reconciler needs no task row for cleanup — ownership comes from
  // the link row itself.
  const candidateIds=new Set(candidates.map(t=>t.id));
  // Orphans are link-owning task ids with NO task row at all (e.g. a merge
  // loser). A linked task whose row exists but is quarantined
  // (importedUnreviewed) is deliberately left untouched — pause semantics,
  // not cleanup — so it must not be mistaken for an orphan.
  const orphanIds=[...new Set(this.deps.store.list<{taskId:string}>('calendar_link').map(r=>r.data.taskId))]
   .filter(id=>!candidateIds.has(id)&&!this.deps.store.get('tasks',id));
  const orphans=new Set(orphanIds);
  for(const id of orphanIds)candidates.push({id,version:0,title:'',notes:'',status:'complete',kind:'manual',officialDue:{kind:'unknown'},sourceRefs:[],confidence:'clear',createdAt:'',updatedAt:''});
  candidates.sort((a,b)=>a.createdAt===b.createdAt?(a.id<b.id?-1:1):(a.createdAt<b.createdAt?-1:1));
  // Durable fair rotation: begin the bounded pass after the task the previous
  // pass processed last, so later tasks are considered even when older tasks
  // stay open, unchanged, blocked or review-only. The cursor is written on its
  // own after the pass (durable; a crashed pass simply re-picks the same set).
  const cursor=this.deps.store.get<{last?:string}>('reconcile_cursor','owner')?.data.last??'';
  const cursorIndex=candidates.findIndex(t=>t.createdAt+':'+t.id===cursor);
  const start=cursorIndex<0?0:cursorIndex+1;
  const rotated=start>0?candidates.slice(start).concat(candidates.slice(0,start)):candidates;
  const evaluated=rotated.map(task=>{
   // Orphaned-link cleanup candidates carry no task row: their decision is a
   // synthetic ignore so the reconciler removes the OrbitDesk-owned mappings
   // (ownership comes from the link row, so no destination is guessed).
   if(orphans.has(task.id))return {task,decision:{decision:{mode:'ignore' as const,destinations:[]},reason:'Orphaned calendar links',errors:[]}};
   return {task,decision:decideRoute(task,{rules,sources,accountDefaults:settings.accountDefaults})};
  }).filter(entry=>entry.decision.decision.mode!=='review'); // review/pause never writes and keeps existing events
  const pass=evaluated.slice(0,MAX_RECONCILE_TASKS),deferred=evaluated.length-pass.length;
  const counts={events:0,synced:0,conflict:0,attention:0,skipped:0};
  const issues:string[]=[];
  for(const {task,decision} of pass){
   // Every non-review task reaches the reconciler: 'automatic' keeps the
   // managed event in step, while ignore/complete/dismiss transitions clean
   // up the OrbitDesk-owned mapping (the reconciler returns 'skipped' for
   // no-op cases such as an unknown due time).
   const result=reconciler.reconcile(task,decision.decision);
   if(result.status==='synced'){counts.synced++;counts.events+=result.eventIds.length}
   else if(result.status==='skipped')counts.skipped++;
   else if(result.status==='conflict')counts.conflict++;
   else counts.attention++; // blocked or unknown outcomes need owner attention
   if(result.error&&issues.length<3)issues.push(result.error.slice(0,140));
  }
  if(pass.length){
   const last=pass[pass.length-1].task;
   const row=this.deps.store.get<{last?:string}>('reconcile_cursor','owner');
   this.deps.store.put('reconcile_cursor','owner',{last:last.createdAt+':'+last.id},row?.version??null);
  }
  const summary='Calendar reconcile: '+counts.events+' events, '+counts.synced+' synced, '+counts.conflict+' conflicts, '+counts.attention+' needing attention, '+counts.skipped+' skipped'+(deferred?', '+deferred+' deferred to the next pass':'')+(issues.length?'; '+issues.join(' | '):'');
  return {kind:'reconcile',message:summary,status:counts.conflict+counts.attention>0?'blocked':'success'};
 }

 private previewTask(rule:{label?:string;decision:Parameters<typeof normalizeDecision>[0]}):Task {
  const now=this.deps.clock.iso();
  return {id:'route-preview',version:1,title:typeof rule.label==='string'&&rule.label?rule.label:'Route preview',notes:'',status:'open',kind:'manual',officialDue:{kind:'unknown'},sourceRefs:[],confidence:'clear',createdAt:now,updatedAt:now,override:rule.decision};
 }

 private saveSettings(input:Settings):Settings {
  try{new Intl.DateTimeFormat('en',{timeZone:input.timeZone}).format(0)}
  catch{throw new AppError('INVALID_INPUT','Enter a valid IANA time zone, such as Asia/Kolkata')}
  if(input.aiEnabled&&!input.aiConsent)throw new AppError('INVALID_INPUT','Give explicit data-processing consent before enabling AI');
  const accountDefaults:Record<string,ReturnType<typeof normalizeDecision>>={};
  for(const [connection,decision] of Object.entries(input.accountDefaults))accountDefaults[connection]=normalizeDecision(decision);
  const row=this.deps.store.get<Settings>('settings','owner');
  const saved=this.deps.store.put('settings','owner',{...input,accountDefaults},row?.version??null);
  return saved.data;
 }

 private readSettings():Settings {
  const data=this.deps.store.get<Partial<Settings>>('settings','owner')?.data??{};
  return {
   timeZone:typeof data.timeZone==='string'&&data.timeZone?data.timeZone:'Asia/Kolkata',
   automationEnabled:data.automationEnabled===true,
   aiEnabled:data.aiEnabled===true,
   aiConsent:data.aiConsent===true,
   accountDefaults:data.accountDefaults&&typeof data.accountDefaults==='object'?data.accountDefaults:{},
   retentionDays:typeof data.retentionDays==='number'&&Number.isFinite(data.retentionDays)?data.retentionDays:90
  };
 }

 private writeActivity(entry:ActivityDraft):void {
  this.deps.store.put('activity',this.deps.ids.next(),{...entry,at:this.deps.clock.iso()},null);
 }

 private failureActivity(type:string,error:AppError):void {
  try{this.writeActivity({kind:String(type).slice(0,40),message:(labels[type]??'Request')+' blocked: '+error.message,status:blockedCodes.has(error.code)?'blocked':'error'})}
  catch{/* activity is best-effort; the typed error is still returned */}
 }

 private failure(type:string,code:string,message:string):RpcResponse {
  this.failureActivity(type,new AppError(code,message));
  let state:UiState|undefined;
  try{state=this.getUiState()}catch{/* storage unavailable */}
  return {ok:false,error:{code,message},...(state?{state}:{})};
 }

 private ai():AiProposalService {
  if(!this.deps.aiConfig)throw new AppError('AI_DISABLED','AI assistance is not configured in this environment');
  const configuration=this.deps.aiConfig(this.readSettings());
  if(!configuration)throw new AppError('AI_DISABLED','Enable AI, give explicit processing consent and configure an eligible free key first');
  return new AiProposalService(new GroqClient(this.deps.http,configuration));
 }

 private requireBroker():OAuthBroker {
  if(!this.deps.broker)throw new AppError('SETUP_REQUIRED','Account connections are not configured in this environment');
  return this.deps.broker;
 }

 private get tasks():TaskService {return new TaskService(this.deps.store,this.deps.clock,this.deps.ids)}
 private get conversations():ConversationService {return new ConversationService(this.deps.store,this.deps.clock,this.deps.ids)}
 private get drafts():DraftService {return new DraftService(this.deps.store,this.deps.clock,this.deps.ids)}
 private get exports():ExportService {return new ExportService(this.deps.store,this.deps.clock,this.deps.ids)}
 private get routing():RoutingService {return new RoutingService(this.deps.store,this.deps.clock,this.deps.ids,this.deps.calendars)}
 private get scheduler():SyncScheduler {return new SyncScheduler(this.deps.store,this.deps.clock,this.deps.ids,this.requireSyncPort())}
 private get replies():ReplyService {
  if(!this.deps.sendPort)throw new AppError('SETUP_REQUIRED','Reply sending is not configured in this environment');
  return new ReplyService(this.deps.store,this.deps.clock,this.deps.ids,this.deps.codec,this.deps.sendPort,this.deps.owner);
 }
 private requireSyncPort():SyncPort {
  if(!this.deps.syncPort)throw new AppError('SETUP_REQUIRED','Import syncing is not configured in this environment');
  return this.deps.syncPort;
 }
}

export function createAppService(deps:AppServiceDeps):AppService {return new AppService(deps)}
