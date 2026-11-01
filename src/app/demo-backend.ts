// OrbitDesk local demo backend. This module wires the REAL application
// service (createAppService from src/app/service.ts and the real domain
// modules) to an in-memory record store and SIMULATED external provider
// ports. It implements docs/spec.md's demo requirement: a local demo must be
// labeled and use the same domain/RPC contract with sample data, without
// pretending live integrations work. Every seeded record is labeled
// "(sample)", app.mode is 'demo' (the UI renders its demo banner), and the
// simulated ports below are the only stand-ins for Google.
//
// Contract parity with deployment: commands go in as the same Command
// envelope and come out as the same RpcResponse ({ok:true,state,value} /
// {ok:false,error,state?}); the owner actor is derived here server-side and
// never taken from the payload, exactly like src/app/entrypoints.ts.
//
// Continuity shape: the demo server creates ONE DemoBackend per server
// process and shares it across every browser connection, so the same saved
// workspace shows up on phone and laptop (the phone/laptop continuity demo).
// Data lives until the server process exits. The backend can be rebuilt from
// an explicit UiState (createDemoBackendFromState) — the demo server exposes
// that only behind ORBITDESK_DEMO_ALLOW_RESET=1 (see
// tests/browser/demo-server.mjs: /api/demo/reset, /__test/reset and
// /__test/state); this module itself performs no I/O and enforces no flag.
//
// UiState translation (reset and /__test/state): each posted section becomes
// store rows with the same kind/key scheme the seeder and the domain services
// use — settings/'owner', conversations, messages, tasks, drafts, routes,
// activity, sources keyed by sourceKey(), calendars keyed
// 'cal:<connection>:<sha256(calendarId)>', and connection views into the
// simulated broker's secret store. Row versions are taken from the posted
// records so version-conflict behavior is preserved. Fixture data is lightly
// normalized into domain-valid shapes (RFC Message-ID/References/threadId for
// Gmail records; enum/type defaults) — this is test-fixture translation only
// and never relaxes a domain rule: the rules still run, on valid data.
//
// Safety boundaries: this file performs no outbound calls (no UrlFetchApp and
// no server-side fetch; the simulated ports below are pure memory writes),
// holds no credentials, and is NOT part of the deployed Apps Script bundle
// (scripts/build.mjs bundles only src/app/entrypoints.ts and src/ui/main.ts;
// this module is bundled only by the local demo server).
import {createHash,randomUUID} from 'node:crypto';
import {AppError,type CalendarView,type Capability,type Clock,type Codec,type ConnectionView,type Due,type HttpPort,type Ids,type RecordRow,type RpcResponse,type SecretStore,type Settings,type SourceItem,type Task,type UiState} from '../shared/contracts.js';
import {OAuthBroker,scopesFor} from '../accounts/oauth.js';
import {MemoryRecordStore} from '../storage/record-store.js';
import {sourceKey} from '../tasks/correlate.js';
import {createAppService,type AppServiceDeps} from './service.js';
import type {GroqConfiguration} from '../ai/groq.js';
import type {CalendarPort} from '../providers/google-calendar.js';
import type {ReplySendPort} from '../replies/send.js';
import type {SyncPort} from '../sync/scheduler.js';

export const DEMO_OWNER='demo-owner@orbitdesk.local';

// Node equivalents of the Apps Script runtime ports (runtime.ts). The clock
// and ids are real; the codec uses Buffer; the HttpPort fails closed because
// the demo must never reach the network (AI stays disabled, so nothing should
// call it, and any drift fails loudly instead of dialing out).
const nodeClock:Clock={now:()=>Date.now(),iso:()=>new Date().toISOString()};
const nodeIds:Ids={next:()=>randomUUID(),hash:(value:string)=>createHash('sha256').update(value,'utf8').digest('hex')};
const nodeCodec:Codec={
 encodeBase64:(value:string)=>Buffer.from(value,'utf8').toString('base64'),
 encodeBase64Url:(value:string)=>Buffer.from(value,'utf8').toString('base64url'),
 decodeBase64Url:(value:string)=>Buffer.from(value,'base64url').toString('utf8')
};
const noNetworkHttp:HttpPort={fetch(){throw new AppError('BLOCKED_URL','The local demo does not make outbound network requests')}};

// Simulated account connections (the OAuthBroker's SecretStore rows in
// production). They are 'active' so the real SyncScheduler pages them; no
// token or credential exists anywhere because the demo ports never authorize.
interface DemoConnection extends ConnectionView {subject:string;serviceName:string}
const sampleConnections:DemoConnection[]=[
 {id:'demo-personal',subject:'demo-personal',serviceName:'orbitdesk_demo_manual_personal',email:'personal@orbitdesk.local',label:'Personal (sample)',status:'active',capabilities:['mail.read','mail.send','calendar.list','calendar.read','calendar.write'],paused:false,backgroundReady:false,backgroundCapabilities:[]},
 {id:'demo-school',subject:'demo-school',serviceName:'orbitdesk_demo_manual_school',email:'student@orbitdesk.local',label:'Education (sample)',status:'active',capabilities:['classroom.read'],paused:false,backgroundReady:false,backgroundCapabilities:[]}
];

class DemoSecretStore implements SecretStore {
 private rows=new Map<string,string>();
 get(key:string):string|null{return this.rows.get(key)??null}
 set(key:string,value:string):void{this.rows.set(key,value)}
 remove(key:string):void{this.rows.delete(key)}
 keys(prefix:string):string[]{return [...this.rows.keys()].filter(key=>key.startsWith(prefix))}
 atomic<T>(work:()=>T):T{return work()}
}

// Real OAuthBroker over a simulated secret store: listConnections, pause and
// disconnect behave against in-memory connection views (no credentials exist
// to remove), while any path that would mint a live grant fails closed.
class DemoBroker extends OAuthBroker {
 private readonly secrets:DemoSecretStore;
 constructor(clock:Clock,ids:Ids,connections:DemoConnection[]=sampleConnections){
  const secrets=new DemoSecretStore();
  super({owner:DEMO_OWNER,secrets,factory:{service(){throw new AppError('SETUP_REQUIRED','The local demo does not connect live Google accounts')}},clock,ids});
  this.secrets=secrets;
  this.replaceConnections(connections);
 }
 // Test-state hook (flag-gated in the server): swap the whole connection set.
 replaceConnections(connections:DemoConnection[]):void{
  for(const key of this.secrets.keys('connection:'))this.secrets.remove(key);
  for(const connection of connections)this.secrets.set('connection:'+connection.id,JSON.stringify(connection));
 }
 // Live OAuth would start here; the demo fails closed with an honest message.
 override beginConnection(actor:string,caps:Capability[],_hint?:string,_workflow:'manual'|'agent'='manual'):{pendingId:string;serviceName:string;authorizationUrl:string}{
  this.assertOwner(actor);scopesFor(caps);
  throw new AppError('SETUP_REQUIRED','The local demo does not connect live Google accounts. Deploy the Apps Script web app and authorize there.');
 }
}

// ---------------------------------------------------------------------------
// UiState -> store rows translation (default seed and test-state hooks).
// ---------------------------------------------------------------------------

const recordIdPattern=/^[-A-Za-z0-9_:.]{1,300}$/;
const messageIdPattern=/^<[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/;
const maxPatchedVersion=5000; // /__test/state re-puts to reach a posted version; bound the work
interface RowSpec {kind:string;id:string;version:number;updatedAt:string;data:Record<string,unknown>}

function failImport(message:string):never {throw new AppError('INVALID_IMPORT',message)}
function section(value:Record<string,unknown>,name:string):unknown[] {
 const raw=value[name];
 if(raw===undefined)return [];
 if(!Array.isArray(raw))failImport('Test state section "'+name+'" must be an array');
 return raw;
}
function record(value:unknown,label:string):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))failImport(label+' must be an object');
 return value as Record<string,unknown>;
}
function text(value:unknown,fallback:string):string {return typeof value==='string'?value:fallback}
function strRecord(value:unknown):Record<string,string> {
 const out:Record<string,string>={};
 if(value&&typeof value==='object'&&!Array.isArray(value))for(const [key,item] of Object.entries(value))if(typeof item==='string')out[key]=item;
 return out;
}
function rowVersion(value:unknown,label:string):number {
 const target=typeof value==='number'?value:1;
 if(!Number.isSafeInteger(target)||target<1)failImport(label+' needs a positive integer version');
 if(target>maxPatchedVersion)failImport(label+' version is too large to seed');
 return target;
}
function rowId(value:unknown,label:string,generate:()=>string):string {
 if(value===undefined||value==='')return generate();
 if(typeof value!=='string'||!recordIdPattern.test(value))failImport(label+' has an invalid record id');
 return value;
}
function asDue(value:unknown):Due {
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  const due=value as Record<string,unknown>;
  if(due.kind==='unknown')return {kind:'unknown'};
  if(due.kind==='date'&&typeof due.date==='string')return {kind:'date',date:due.date};
  if(due.kind==='instant'&&typeof due.at==='string'&&typeof due.zone==='string')return {kind:'instant',at:due.at,zone:due.zone};
 }
 return {kind:'unknown'};
}
function normalizeMessageId(value:unknown,fallbackLocal:string):string {
 if(typeof value==='string'&&messageIdPattern.test(value))return value;
 const local=(typeof value==='string'?value:'').replace(/[\x00-\x1f\x7f\s<>"(),:;@\[\]\\]+/g,'')||fallbackLocal;
 return '<'+local+'@test.orbitdesk.local>';
}
function normalizeReferences(value:unknown,threadMessageId:string):string {
 if(typeof value!=='string')return '';
 const seen=new Set<string>();
 for(const token of value.split(/\s+/)){
  if(!token)continue;
  const normalized=messageIdPattern.test(token)?token:normalizeMessageId(token,token.replace(/[\x00-\x1f\x7f\s<>"(),:;@\[\]\\]+/g,''));
  seen.add(normalized);
 }
 if(!seen.has(threadMessageId))seen.add(threadMessageId);
 return [...seen].join(' ');
}
function normalizeThreadId(value:unknown,fallback:string):string {
 if(typeof value==='string'&&value.length<=200&&/^[-A-Za-z0-9_]+$/.test(value))return value;
 const cleaned=(typeof value==='string'?value:'').replace(/[^-A-Za-z0-9_]/g,'-').slice(0,200).replace(/^-+|-+$/g,'');
 return cleaned||fallback;
}
function translateConnections(value:unknown):DemoConnection[] {
 return section({accounts:value},'accounts').map((raw,index)=>{
  const account=record(raw,'accounts['+index+']');
  const id=rowId(account.id,'accounts['+index+']',()=>idFallback(index));
  const status=typeof account.status==='string'&&['active','reconnect','blocked','disconnected'].includes(account.status)?account.status as ConnectionView['status']:'active';
  const connection:DemoConnection={
   id,subject:id,serviceName:'orbitdesk_test_'+id.replace(/[^-A-Za-z0-9_]/g,'_'),
   email:text(account.email,id+'@orbitdesk.local'),label:text(account.label,id),status,
   capabilities:(Array.isArray(account.capabilities)?account.capabilities:[]).filter((item):item is Capability=>typeof item==='string'),
   paused:account.paused===true,backgroundReady:false,backgroundCapabilities:[]
  };
  if(typeof account.lastSync==='string'&&account.lastSync)connection.lastSync=account.lastSync;
  if(typeof account.error==='string'&&account.error)connection.error=account.error;
  return connection;
 });
}
function idFallback(index:number):string {return 'test-'+index}
function translateState(state:Record<string,unknown>,clock:Clock,ids:Ids):{rows:RecordRow[];connections:DemoConnection[]} {
 const at=clock.iso();
 const rows:RecordRow[]=[];
 const connections=translateConnections(state.accounts);
 // settings
 const rawSettings=state.settings===undefined?{}:record(state.settings,'settings');
 const settings:Settings={
  timeZone:text(rawSettings.timeZone,'Asia/Kolkata'),
  automationEnabled:rawSettings.automationEnabled===true,
  aiEnabled:rawSettings.aiEnabled===true,
  aiConsent:rawSettings.aiConsent===true,
  accountDefaults:rawSettings.accountDefaults&&typeof rawSettings.accountDefaults==='object'&&!Array.isArray(rawSettings.accountDefaults)?rawSettings.accountDefaults as Settings['accountDefaults']:{},
  retentionDays:typeof rawSettings.retentionDays==='number'&&Number.isSafeInteger(rawSettings.retentionDays)?rawSettings.retentionDays:90
 };
 rows.push({kind:'settings',id:'owner',version:1,updatedAt:at,data:settings as unknown as Record<string,unknown>});
 // conversations
 section(state,'conversations').forEach((raw,index)=>{
  const conversation=record(raw,'conversations['+index+']');
  const id=rowId(conversation.id,'conversations['+index+']',()=>ids.next());
  const version=rowVersion(conversation.version,'conversations['+index+']');
  rows.push({kind:'conversations',id,version,updatedAt:text(conversation.updatedAt,at),data:{...conversation,id,version,title:text(conversation.title,'(sample)'),createdAt:text(conversation.createdAt,at),updatedAt:text(conversation.updatedAt,at)}});
 });
 // messages
 section(state,'messages').forEach((raw,index)=>{
  const message=record(raw,'messages['+index+']');
  const id=rowId(message.id,'messages['+index+']',()=>ids.next());
  const version=rowVersion(message.version,'messages['+index+']');
  rows.push({kind:'messages',id,version,updatedAt:text(message.updatedAt,at),data:{...message,id,version,conversationId:text(message.conversationId,''),role:message.role==='assistant'?'assistant':'user',text:text(message.text,''),sequence:typeof message.sequence==='number'?message.sequence:index+1,createdAt:text(message.createdAt,at),updatedAt:text(message.updatedAt,at)}});
 });
 // sources (keyed by sourceKey, like ImportService)
 section(state,'sources').forEach((raw,index)=>{
  const source=record(raw,'sources['+index+']');
  const type=source.type==='gmail'||source.type==='classroom'?source.type:failImport('sources['+index+'] needs type "gmail" or "classroom"');
  const item={...source,connectionId:text(source.connectionId,''),type,id:text(source.id,''),receivedAt:text(source.receivedAt,at),updatedAt:text(source.updatedAt,at)} as SourceItem;
  let key:string;
  try{key=sourceKey(item)}
  catch{failImport('sources['+index+'] has an invalid source identity for keying')}
  rows.push({kind:'sources',id:key,version:1,updatedAt:item.updatedAt,data:{...item,rfcMessageId:type==='gmail'?normalizeMessageId(source.rfcMessageId,item.id||'mail-'+index):source.rfcMessageId} as Record<string,unknown>});
 });
 // tasks
 section(state,'tasks').forEach((raw,index)=>{
  const task=record(raw,'tasks['+index+']');
  const id=rowId(task.id,'tasks['+index+']',()=>ids.next());
  const version=rowVersion(task.version,'tasks['+index+']');
  rows.push({kind:'tasks',id,version,updatedAt:text(task.updatedAt,at),data:{...task,id,version,title:text(task.title,'(sample)'),notes:text(task.notes,''),status:task.status==='complete'||task.status==='dismissed'?task.status:'open',kind:task.kind==='gmail'||task.kind==='classroom'?task.kind:'manual',officialDue:asDue(task.officialDue),...(task.plannedDue!==undefined?{plannedDue:asDue(task.plannedDue)}:{}),sourceRefs:Array.isArray(task.sourceRefs)?task.sourceRefs:[],confidence:task.confidence==='review'?'review':'clear',...(task.override!==undefined&&task.override!==null?{override:record(task.override,'tasks['+index+'].override')}:{}),...(task.importedUnreviewed===true?{importedUnreviewed:true}:{}),createdAt:text(task.createdAt,at),updatedAt:text(task.updatedAt,at)}});
 });
 // drafts
 section(state,'drafts').forEach((raw,index)=>{
  const draft=record(raw,'drafts['+index+']');
  const id=rowId(draft.id,'drafts['+index+']',()=>ids.next());
  const version=rowVersion(draft.version,'drafts['+index+']');
  const messageId=normalizeMessageId(draft.messageId,id);
  rows.push({kind:'drafts',id,version,updatedAt:text(draft.updatedAt,at),data:{...draft,id,version,connectionId:text(draft.connectionId,''),sourceId:text(draft.sourceId,''),threadId:normalizeThreadId(draft.threadId,'thread-'+id),messageId,references:normalizeReferences(draft.references,messageId),subject:text(draft.subject,'(sample)'),to:Array.isArray(draft.to)?draft.to.filter((item):item is string=>typeof item==='string'):[],body:text(draft.body,''),userContent:text(draft.userContent,''),status:['draft','authorized','pending','sent','unknown','failed'].includes(draft.status as string)?draft.status:'draft',rephrased:draft.rephrased===true,importedUnreviewed:draft.importedUnreviewed===true,createdAt:text(draft.createdAt,at),updatedAt:text(draft.updatedAt,at)}});
 });
 // routes
 section(state,'routes').forEach((raw,index)=>{
  const rule=record(raw,'routes['+index+']');
  const id=rowId(rule.id,'routes['+index+']',()=>ids.next());
  const version=rowVersion(rule.version,'routes['+index+']');
  const decisionRaw=rule.decision&&typeof rule.decision==='object'&&!Array.isArray(rule.decision)?rule.decision as Record<string,unknown>:{};
  const destinations=(Array.isArray(decisionRaw.destinations)?decisionRaw.destinations:[]).map(item=>{const d=record(item,'routes['+index+'].decision.destinations');return {connectionId:text(d.connectionId,''),calendarId:text(d.calendarId,'')}});
  rows.push({kind:'routes',id,version,updatedAt:text(rule.updatedAt,at),data:{...rule,id,version,label:text(rule.label,'(sample)'),sourceConnectionIds:Array.isArray(rule.sourceConnectionIds)?rule.sourceConnectionIds.filter((item):item is string=>typeof item==='string'):[],priority:typeof rule.priority==='number'&&Number.isFinite(rule.priority)?rule.priority:100,enabled:rule.enabled===true,conditions:strRecord(rule.conditions),decision:{mode:decisionRaw.mode==='automatic'||decisionRaw.mode==='ignore'?decisionRaw.mode:'review',destinations}}});
 });
 // calendars (store cache rows keyed like refreshCalendars)
 section(state,'calendars').forEach((raw,index)=>{
  const calendar=record(raw,'calendars['+index+']');
  const connectionId=text(calendar.connectionId,'');
  const calendarId=text(calendar.id,'');
  if(!recordIdPattern.test(connectionId)||!calendarId)failImport('calendars['+index+'] needs a valid connectionId and id');
  rows.push({kind:'calendars',id:'cal:'+connectionId+':'+ids.hash(calendarId),version:1,updatedAt:at,data:{connectionId,id:calendarId,summary:text(calendar.summary,calendarId),accessRole:text(calendar.accessRole,'reader'),writable:calendar.writable===true}});
 });
 // activity
 section(state,'activity').forEach((raw,index)=>{
  const entry=record(raw,'activity['+index+']');
  const id=rowId(entry.id,'activity['+index+']',()=>'test-activity-'+index);
  rows.push({kind:'activity',id,version:1,updatedAt:at,data:{kind:text(entry.kind,'test'),message:text(entry.message,'(sample)'),status:['success','pending','blocked','unknown','error'].includes(entry.status as string)?entry.status:'success',at:text(entry.at,at)}});
 });
 return {rows,connections};
}

// The default demo workspace, expressed as a UiState so it flows through the
// same translation as posted test state. Everything is labeled "(sample)".
function defaultDemoState(clock:Clock):UiState {
 const at=clock.iso();
 return {
  app:{mode:'demo',owner:DEMO_OWNER,storageReady:true,aiConfigured:false,setupRequired:[]},
  settings:{timeZone:'Asia/Kolkata',automationEnabled:false,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90},
  accounts:sampleConnections.map(({id,email,label,status,capabilities,paused})=>({id,email,label,status,capabilities:[...capabilities],paused})),
  calendars:[
   {connectionId:'demo-personal',id:'primary',summary:'Demo calendar (sample)',accessRole:'owner',writable:true},
   {connectionId:'demo-personal',id:'readonly',summary:'Shared read-only (sample)',accessRole:'reader',writable:false}
  ],
  tasks:[
   {id:'task-sample-circuits',version:1,title:'Prepare circuits problem set (sample)',notes:'Imported from the sample Classroom source. Due time has not been supplied. This item is importedUnreviewed: review it before any calendar routing.',status:'open',kind:'classroom',officialDue:{kind:'unknown'},sourceRefs:[{connectionId:'demo-school',type:'classroom',id:'cw-1',courseId:'course-demo',courseworkId:'cw-1'}],confidence:'review',importedUnreviewed:true,createdAt:at,updatedAt:at},
   {id:'task-sample-override',version:1,title:'Plan project review (sample)',notes:'Manual task with an explicit item override, so it outranks the matching rule and the account default.',status:'open',kind:'manual',officialDue:{kind:'date',date:'2026-11-05'},plannedDue:{kind:'date',date:'2026-11-04'},sourceRefs:[],confidence:'clear',override:{mode:'review',destinations:[{connectionId:'demo-personal',calendarId:'primary'}]},createdAt:at,updatedAt:at},
   {id:'task-sample-standup',version:1,title:'Plan team stand-up (sample)',notes:'Ordinary manual task from the demo seed.',status:'open',kind:'manual',officialDue:{kind:'unknown'},sourceRefs:[],confidence:'clear',createdAt:at,updatedAt:at}
  ],
  conversations:[{id:'chat-welcome',version:1,title:'Welcome to OrbitDesk (sample)',createdAt:at,updatedAt:at}],
  messages:[{id:'msg-welcome',conversationId:'chat-welcome',role:'assistant',text:'This local demo runs the real OrbitDesk domain services on sample data. No Google account is connected, nothing is sent and no calendar is changed. Every browser connected to this demo server shares this workspace until the server exits.',version:1,createdAt:at}],
  drafts:[{id:'draft-sample-1',version:1,connectionId:'demo-personal',sourceId:'mail-1',threadId:'thread-1',messageId:'<rfc-demo-mail-1@demo.orbitdesk.local>',references:'<rfc-demo-mail-1@demo.orbitdesk.local>',subject:'Project catch-up (sample)',to:['colleague@example.test'],body:'',userContent:'',status:'draft',rephrased:false,importedUnreviewed:true,createdAt:at,updatedAt:at}],
  routes:[{id:'rule-sample-1',version:1,label:'Classwork to demo calendar (sample)',sourceConnectionIds:['demo-school'],priority:100,enabled:true,conditions:{courseId:'course-demo'},decision:{mode:'review',destinations:[{connectionId:'demo-personal',calendarId:'primary'}]}}],
  activity:[
   {id:'activity-sample-1',at,kind:'demo',message:'Demo workspace created with sample data. No Google account is connected and nothing is sent.',status:'success'},
   {id:'activity-sample-2',at,kind:'demo',message:'Automation and AI stay off in the demo. Manual planning, reply drafts and exports remain available.',status:'success'}
  ],
  sources:[
   {connectionId:'demo-personal',id:'mail-1',type:'gmail',title:'Project catch-up (sample)',text:'Could you share a short update on the launch plan this week?',receivedAt:at,updatedAt:at,sender:'colleague@example.test',threadId:'thread-1',rfcMessageId:'<rfc-demo-mail-1@demo.orbitdesk.local>'},
   {connectionId:'demo-school',id:'cw-1',type:'classroom',title:'Circuits problem set (sample)',text:'Published coursework. Due time has not been supplied.',receivedAt:at,updatedAt:at,courseId:'course-demo',courseworkId:'cw-1',officialDue:{kind:'unknown'},submissionState:'published'}
  ]
 };
}

export interface DemoBackend {
 // Same entry contract as the deployed rpc() entrypoint, with the owner actor
 // derived here instead of from the caller.
 handle(command:unknown):RpcResponse;
 // Test-state hook (the demo server gates it behind ORBITDESK_DEMO_ALLOW_RESET=1):
 // applies a Partial<UiState> patch to the CURRENT shared store — array
 // sections replace the whole kind, rows carry the posted versions.
 applyTestState(patch:unknown):RpcResponse;
 // Observable simulation logs for manual verification of the demo ports.
 sentLog():readonly {id:string;threadId:string;at:string}[];
 syncPages():number;
}

export function createDemoBackend(options:{state?:unknown}={}):DemoBackend {
 const clock=nodeClock,ids=nodeIds;
 const {rows,connections}=translateState(record(options.state??defaultDemoState(clock),'demo state'),clock,ids);
 const store=new MemoryRecordStore(clock,rows);
 const broker=new DemoBroker(clock,ids,connections);
 let syncPages=0;
 const syncPort:SyncPort={
  // Simulated import page: NO network. Each call writes one fresh, clearly
  // labeled source record plus one matching task directly through the store
  // with sourceKey-style ids (ImportService is deliberately not used in the
  // demo), then returns a bounded, scheduler-valid page result. Works for any
  // connection id: classroom-flavored ids get coursework, the rest get mail.
  page(connectionId,_checkpoint,allowance){
   if(allowance.maxCalls<1)throw new AppError('INVALID_BUDGET','The demo sync page needs at least one reserved call');
   syncPages++;
   const run=syncPages,at=clock.iso();
   if(/school|classroom|edu/i.test(connectionId)){
    const courseworkId='cw-sync-'+run;
    const source:SourceItem={connectionId,id:courseworkId,type:'classroom',title:'Synced coursework (sample #'+run+')',text:'Published coursework (sample). Due time has not been supplied.',receivedAt:at,updatedAt:at,courseId:'course-demo',courseworkId,officialDue:{kind:'unknown'},submissionState:'published'};
    store.put('sources','classroom:'+connectionId+':course-demo:'+courseworkId,source,null);
    const task:Task={id:'task:sync:'+connectionId+':'+courseworkId,version:1,title:'Work on synced coursework (sample #'+run+')',notes:'Created by the demo sync simulator. importedUnreviewed: review before routing.',status:'open',kind:'classroom',officialDue:{kind:'unknown'},sourceRefs:[{connectionId,type:'classroom',id:courseworkId,courseId:'course-demo',courseworkId}],confidence:'clear',importedUnreviewed:true,createdAt:at,updatedAt:at};
    store.put('tasks',task.id,task,null);
    return {checkpoint:null,done:true,consumedCalls:1,items:2};
   }
   const id='a'+run;
   const source:SourceItem={connectionId,id,type:'gmail',title:'Synced Gmail update (sample #'+run+')',text:'This record was written by the demo sync simulator; no network request was made.',receivedAt:at,updatedAt:at,sender:'sync@orbitdesk.local',threadId:'thread-demo-'+run,rfcMessageId:'<rfc-demo-'+run+'@demo.orbitdesk.local>'};
   store.put('sources','gmail:'+connectionId+':'+id,source,null);
   const task:Task={id:'task:sync:'+connectionId+':'+id,version:1,title:'Follow up on synced mail (sample #'+run+')',notes:'Created by the demo sync simulator. importedUnreviewed: review before routing.',status:'open',kind:'gmail',officialDue:{kind:'unknown'},sourceRefs:[{connectionId,type:'gmail',id}],confidence:'review',importedUnreviewed:true,createdAt:at,updatedAt:at};
   store.put('tasks',task.id,task,null);
   return {checkpoint:null,done:true,consumedCalls:1,items:2};
  }
 };
 let sentCount=0;
 const sentLog:{id:string;threadId:string;at:string}[]=[];
 const sendPort:ReplySendPort={
  // Simulated Gmail send: the real ReplyService runs its full safety flow
  // (exact version, explicit instruction, pending write, then outcome), but
  // the "send" is only recorded in this in-memory log. No email exists.
  send(_connectionId,payload){
   sentCount++;
   const result={id:'demo-sent-'+sentCount,threadId:payload.threadId};
   sentLog.push({...result,at:clock.iso()});
   return result;
  }
 };
 const calendars:Pick<CalendarPort,'listCalendars'>={
  // Simulated calendar list: one writable destination and one read-only, so
  // route.preview writability checks (and their errors) are exercisable.
  listCalendars(connectionId:string):CalendarView[] {return [
   {connectionId,id:'primary',summary:'Demo calendar (sample)',accessRole:'owner',writable:true},
   {connectionId,id:'readonly',summary:'Shared read-only (sample)',accessRole:'reader',writable:false}
  ]}
 };
 const deps:AppServiceDeps={
  owner:DEMO_OWNER,
  store,
  clock,
  ids,
  codec:nodeCodec,
  http:noNetworkHttp,
  broker,
  sendPort,
  syncPort,
  calendars,
  aiConfig:():GroqConfiguration=>({enabled:false}), // demo AI stays off; draft.rephrase fails closed with AI_DISABLED
  setupChecks:()=>[],
  mode:'demo'
 };
 const service=createAppService(deps);
 const currentState=():UiState=>{
  const response=service.handle({kind:'user',email:DEMO_OWNER},{type:'state.get',requestId:'__test-state-read',payload:{}});
  if(!response.ok)throw new AppError('INTERNAL_ERROR','The demo workspace state could not be read');
  return response.state;
 };
 const putAtVersion=(kind:string,id:string,data:Record<string,unknown>,targetVersion:number):void=>{
  let row=store.get(kind,id);
  if(!row)row=store.put(kind,id,data,null);
  while(row.version<targetVersion)row=store.put(kind,id,data,row.version);
 };
 const replaceSection=(kind:string,specs:RowSpec[]):void=>{
  for(const row of store.list(kind))store.remove(kind,row.id,row.version);
  for(const spec of specs)putAtVersion(kind,spec.id,spec.data,spec.version);
 };
 const backend:DemoBackend={
  handle:(command:unknown):RpcResponse=>service.handle({kind:'user',email:DEMO_OWNER},command),
  applyTestState(patch:unknown):RpcResponse{
   try{
    const sections=record(patch,'test state patch');
    store.atomic(()=>{
     if(sections.settings!==undefined)replaceSection('settings',[{kind:'settings',id:'owner',version:1,updatedAt:clock.iso(),data:translateState({settings:sections.settings},clock,ids).rows[0].data as Record<string,unknown>}]);
     if(sections.accounts!==undefined)broker.replaceConnections(translateConnections(sections.accounts));
     if(sections.calendars!==undefined)replaceSection('calendars',translateState({calendars:sections.calendars},clock,ids).rows.filter(row=>row.kind==='calendars').map(row=>({kind:'calendars',id:row.id,version:row.version,updatedAt:row.updatedAt,data:row.data as Record<string,unknown>})));
     for(const name of ['conversations','messages','tasks','drafts','routes','activity','sources']){
      if(sections[name]===undefined)continue;
      const translated=translateState({[name]:sections[name]},clock,ids).rows.filter(row=>row.kind===name);
      replaceSection(name,translated.map(row=>({kind:name,id:row.id,version:row.version,updatedAt:row.updatedAt,data:row.data as Record<string,unknown>})));
     }
    });
    return {ok:true,state:currentState()};
   }catch(error){
    return {ok:false,error:error instanceof AppError?{code:error.code,message:error.message}:{code:'INTERNAL_ERROR',message:'The test state patch could not be applied'}};
   }
  },
  sentLog:()=>[...sentLog],
  syncPages:()=>syncPages
 };
 return backend;
}

// Rebuild a demo backend from a posted UiState (flag-gated test hook in the
// demo server). Invalid sections fail closed with INVALID_IMPORT.
export function createDemoBackendFromState(state:unknown):DemoBackend {return createDemoBackend({state})}
