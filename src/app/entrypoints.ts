import {AppError} from '../shared/contracts.js';
import {requireOwner,configuredOwner,productionBroker,safeError,AppsHttp,appsClock,appsIds,appsCodec,scriptAtomic,ScriptSecrets} from './runtime.js';
import {AppService,type AppServiceDeps} from './service.js';
import {SheetRecordStore,AppsSheetPort} from '../storage/sheets-store.js';
import {GoogleTransport} from '../providers/transport.js';
import {GmailAdapter} from '../providers/gmail.js';
import {ClassroomAdapter} from '../providers/classroom.js';
import {GoogleCalendar} from '../providers/google-calendar.js';
import {GmailReplyPort} from '../replies/send.js';
import {ImportService} from '../sync/imports.js';
import {TaskService} from '../tasks/task-service.js';
import type {Clock,Codec,HttpPort,Ids,RecordStore,Capability} from '../shared/contracts.js';
import type {OAuthBroker} from '../accounts/oauth.js';
import type {SyncPort} from '../sync/scheduler.js';

export function doGet(_e?:unknown):GoogleAppsScript.HTML.HtmlOutput {
 try {requireOwner();return HtmlService.createTemplateFromFile('Index').evaluate().setTitle('OrbitDesk').addMetaTag('viewport','width=device-width, initial-scale=1')}
 catch {return HtmlService.createHtmlOutput('<h1>Owner access required</h1><p>Open OrbitDesk while signed into its owner account.</p>')}
}

// OrbitDesk storage property: the private Google Sheet holding every
// app-owned record is configured through the Script Property
// 'STORAGE_SPREADSHEET_ID' (spreadsheet ID only; credentials stay in their own
// restricted properties). SheetRecordStore opens the first worksheet of that
// spreadsheet under the script lock and writes the record header row on first
// save, so a fresh empty worksheet needs no manual setup.
const STORAGE_SPREADSHEET_ID='STORAGE_SPREADSHEET_ID';
function openStore():RecordStore {
 const id=PropertiesService.getScriptProperties().getProperty(STORAGE_SPREADSHEET_ID);
 if(!id)throw new AppError('SETUP_REQUIRED','Set the STORAGE_SPREADSHEET_ID script property to the private OrbitDesk spreadsheet');
 const sheet=SpreadsheetApp.openById(id).getSheets()[0];
 if(!sheet)throw new AppError('SETUP_REQUIRED','The storage spreadsheet needs at least one worksheet');
 return new SheetRecordStore(new AppsSheetPort(sheet),appsClock,scriptAtomic);
}

// Bounded bridge between the scheduler's page allowance and the stateful
// import services. Each provider request is charged against the reserved call
// budget; import checkpoints stay in the store, so the port reports a null
// checkpoint and relies on ImportService's durable resume state. Providers are
// selected from the connection's effective capabilities in the selected
// workflow: a Gmail-only account never touches Classroom and vice versa;
// combined accounts give both providers bounded fair progress every page.
function importSyncPort(store:RecordStore,broker:OAuthBroker,http:HttpPort,clock:Clock,ids:Ids,codec:Codec,workflow:'manual'|'agent',owner:string):SyncPort {
 const transport=new GoogleTransport(broker,http,workflow);
 const imports=new ImportService(store,new GmailAdapter(transport,codec,clock),new ClassroomAdapter(transport,clock),new TaskService(store,clock,ids),clock);
 const effectiveCaps=(connectionId:string):Set<Capability>=>{
  const account=broker.listConnections(owner).find(c=>c.id===connectionId);
  return new Set(account?workflow==='agent'?account.backgroundCapabilities??[]:account.capabilities:[]);
 };
 return {
  page:(connectionId,_checkpoint,allowance)=>{
   const caps=effectiveCaps(connectionId);
   const useGmail=caps.has('mail.read'),useClassroom=caps.has('classroom.read');
   if(!useGmail&&!useClassroom)return {checkpoint:null,done:true,consumedCalls:0,items:0};
   if(useGmail&&useClassroom){
    const share=Math.max(1,Math.floor(allowance.maxCalls/2));
    const gmail=imports.syncGmail(connectionId,{maxRequests:Math.min(share,allowance.maxCalls)});
    const remaining=allowance.maxCalls-gmail.requests;
    const classroom=remaining>0?imports.syncClassroom(connectionId,{maxRequests:Math.min(Math.max(1,share),remaining)}):{requests:0,imported:0,hasMore:true};
    return {checkpoint:null,done:!gmail.hasMore&&!classroom.hasMore,consumedCalls:gmail.requests+classroom.requests,items:gmail.imported+classroom.imported};
   }
   if(useGmail){const gmail=imports.syncGmail(connectionId,{maxRequests:allowance.maxCalls});return {checkpoint:null,done:!gmail.hasMore,consumedCalls:gmail.requests,items:gmail.imported};}
   const classroom=imports.syncClassroom(connectionId,{maxRequests:allowance.maxCalls});
   return {checkpoint:null,done:!classroom.hasMore,consumedCalls:classroom.requests,items:classroom.imported};
  }
 };
}

// Apps Script globals do not survive between executions, so the service is
// rebuilt for every invocation; SheetRecordStore reopens the same spreadsheet
// each time and every command runs inside store.atomic (script lock), which
// serializes concurrent web app and trigger executions. No CacheService
// memoization is needed. `workflow` selects which OAuth grant the sync pages
// use: 'manual' for the Sync now button, 'agent' for scheduled triggers
// (background work needs its own authorized background grant).
function liveService(owner:string,workflow:'manual'|'agent'):AppService {
 const secrets=new ScriptSecrets();
 const store=openStore();
 const http:HttpPort=new AppsHttp();
 const broker=productionBroker();
 const deps:AppServiceDeps={
  owner,store,clock:appsClock,ids:appsIds,codec:appsCodec,http,
  broker,
  // Sends are always direct, owner-instructed actions: they keep the manual
  // grant even in a trigger context.
  sendPort:new GmailReplyPort(new GoogleTransport(broker,http,'manual')),
  syncPort:importSyncPort(store,broker,http,appsClock,appsIds,appsCodec,workflow,owner),
  // Scheduled calendar operations use the explicitly authorized background
  // workflow; missing, paused or insufficient background grants fail closed
  // (OAuthBroker.access has no fallback to manual credentials).
  calendars:new GoogleCalendar(new GoogleTransport(broker,http,workflow)),
  aiConfig:(settings)=>({enabled:settings.aiEnabled,consent:settings.aiConsent,apiKey:secrets.get('GROQ_API_KEY')??undefined,model:secrets.get('GROQ_MODEL')??undefined,freePlanConfirmed:secrets.get('GROQ_FREE_PLAN_CONFIRMED')==='true'}),
  setupChecks:()=>{
   const properties=PropertiesService.getScriptProperties().getProperties();
   const required:string[]=[];
   if(!properties.GOOGLE_CLIENT_ID||!properties.GOOGLE_CLIENT_SECRET)required.push('Google sign-in credentials are missing from restricted script properties');
   return required;
  }
 };
 return new AppService(deps);
}

export function rpc(command:unknown):unknown {
 try {
  // The actor is derived here from the authenticated session and passed to the
  // service; payload fields can never supply identity or send authority.
  const owner=requireOwner();
  const service=liveService(owner,'manual');
  return service.handle({kind:'user',email:owner},command);
 } catch(e){return {ok:false,error:safeError(e)}}
}

export function authCallback(e:{parameter:Record<string,string>}):GoogleAppsScript.HTML.HtmlOutput {
 try {
  // Apps Script validates the signed state token before dispatching this callback.
  // The pending request is additionally owner-bound, expiring and single-use.
  const owner=configuredOwner();
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==owner)throw Error('Wrong callback execution identity');
  const result=productionBroker().completeConnection(owner,e.parameter);
  return HtmlService.createHtmlOutput(result.status==='connected'?'<h1>Google account connected</h1><p>Return to OrbitDesk and refresh account status.</p>':'<h1>Access was not granted</h1><p>Your other accounts were not changed.</p>');
 } catch {return HtmlService.createHtmlOutput('<h1>Connection could not be completed</h1><p>Return to OrbitDesk and start a new connection request.</p>')}
}

// Time-driven trigger entrypoint. It installs nothing itself and honors the
// settings.automationEnabled gate (default off). Scheduled pages use the
// 'agent' background grant; overlapping rounds fail with status 'busy'.
export function scheduledSync(_e?:unknown):unknown {
 let owner:string;
 try{owner=configuredOwner()}
 catch{return {status:'setup_required',pages:0,items:0}}
 try{return liveService(owner,'agent').runScheduledSync()}
 catch(e){
  const error=safeError(e);
  if(error.code==='BUSY')return {status:'busy',pages:0,items:0};
  if(error.code==='SETUP_REQUIRED')return {status:'setup_required',pages:0,items:0};
  return {status:'error',pages:0,items:0,error};
 }
}
