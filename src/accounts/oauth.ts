import {AppError,type Capability,type Clock,type Ids,type SecretStore,type ConnectionView} from '../shared/contracts.js';
export interface GoogleIdentity {sub:string;email:string;emailVerified:boolean;scopes:string[]}
export interface OAuthService {authorizationUrl(params:Record<string,string>):string;exchange(callback:Record<string,string>):boolean;identity():GoogleIdentity;accessToken():string;reset():void}
export interface OAuthFactory {service(name:string,capabilities?:Capability[],workflow?:'manual'|'agent'):OAuthService}
export interface BrokerOptions {owner:string;secrets:SecretStore;factory:OAuthFactory;clock:Clock;ids:Ids}
interface Pending {id:string;serviceName:string;owner:string;expires:number;capabilities:Capability[];workflow:'manual'|'agent';hint?:string}
interface PrivateConnection extends ConnectionView {subject:string;serviceName:string;agentServiceName?:string}
export const GOOGLE_SCOPES:Record<Capability,string>={
 'mail.read':'https://www.googleapis.com/auth/gmail.readonly',
 'mail.send':'https://www.googleapis.com/auth/gmail.send',
 'calendar.list':'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
 'calendar.read':'https://www.googleapis.com/auth/calendar.events.readonly',
 'calendar.write':'https://www.googleapis.com/auth/calendar.events',
 'classroom.read':'https://www.googleapis.com/auth/classroom.coursework.me.readonly'
};
export function scopesFor(capabilities:Capability[]):string[] {
 const scopes=['openid','https://www.googleapis.com/auth/userinfo.email'];
 for(const cap of capabilities) {
  const scope=GOOGLE_SCOPES[cap];if(!scope)throw new AppError('INVALID_CAPABILITY','Unsupported account permission');
  scopes.push(scope);
  if(cap==='classroom.read')scopes.push('https://www.googleapis.com/auth/classroom.courses.readonly');
 }
 return [...new Set(scopes)];
}
const normalize=(s:string)=>s.trim().toLowerCase();
function view(c:PrivateConnection):ConnectionView {
 return {id:c.id,email:c.email,label:c.label,status:c.status,capabilities:[...c.capabilities],paused:c.paused,backgroundReady:Boolean(c.agentServiceName),backgroundCapabilities:[...(c.backgroundCapabilities??[])],...(c.lastSync?{lastSync:c.lastSync}:{}),...(c.error?{error:c.error}:{})};
}
export class OAuthBroker {
 constructor(private options:BrokerOptions) {}
 assertOwner(actor:string):void {
  if(!actor||normalize(actor)!==normalize(this.options.owner))throw new AppError('UNAUTHORIZED','Owner access required');
 }
 beginConnection(actor:string,caps:Capability[],hint?:string,workflow:'manual'|'agent'='manual'):{pendingId:string;serviceName:string;authorizationUrl:string}{
  this.assertOwner(actor);if(!['manual','agent'].includes(workflow))throw new AppError('INVALID_WORKFLOW','Unsupported authorization workflow');const capabilities=[...new Set(caps)];
  if(!capabilities.length||capabilities.length>6)throw new AppError('INVALID_CAPABILITY','Choose at least one account permission');
  scopesFor(capabilities);
  if(hint&&(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(hint)||hint.length>254))throw new AppError('INVALID_EMAIL','Enter a valid account email');
  const now=this.options.clock.now();
  this.options.secrets.atomic(()=>{
   for(const key of this.options.secrets.keys('pending:')) {
    // One corrupted property must never brick new connections: unparseable
    // pending entries are removed instead of thrown (LOW-4).
    try {
     const p=JSON.parse(this.options.secrets.get(key)!) as Pending;
     if(!p||typeof p.expires!=='number'||p.expires<=now)this.options.secrets.remove(key);
    }catch{this.options.secrets.remove(key)}
   }
   if(this.options.secrets.keys('pending:').length>=10)throw new AppError('LINK_LIMIT','Finish or wait for an existing connection request');
  });
  const id=this.options.ids.next(),serviceName='orbitdesk_'+workflow+'_'+id;
  const pending:Pending={id,serviceName,owner:normalize(actor),expires:now+10*60_000,capabilities,workflow,...(hint?{hint:normalize(hint)}:{})};
  this.options.secrets.set('pending:'+id,JSON.stringify(pending));
  try {
   // The hint rides in the state token and is forwarded to the factory so the
   // authorization URL can bind Google's account chooser via login_hint (LOW-1).
   const url=this.options.factory.service(serviceName,capabilities,workflow).authorizationUrl({pendingId:id,...(hint?{hint}:{})});
   if(!url.startsWith('https://accounts.google.com/'))throw new AppError('LINK_FAILED','Google sign-in could not be prepared');
   return {pendingId:id,serviceName,authorizationUrl:url};
  } catch {
   this.options.secrets.remove('pending:'+id);throw new AppError('LINK_FAILED','Google sign-in could not be prepared');
  }
 }
 completeConnection(actor:string,callback:Record<string,string>):{status:'connected'|'blocked';connection?:ConnectionView}{
  this.assertOwner(actor);
  const pending=this.options.secrets.atomic(()=>{
   const raw=this.options.secrets.get('pending:'+callback.pendingId);
   if(!raw)throw new AppError('STALE_CALLBACK','Connection request is no longer active');
   const p=JSON.parse(raw) as Pending;
   if(p.owner!==normalize(actor)||p.serviceName!==callback.serviceName)throw new AppError('WRONG_CALLBACK','Connection callback does not match');
   if(p.expires<=this.options.clock.now()) {
    this.options.secrets.remove('pending:'+p.id);throw new AppError('EXPIRED_CALLBACK','Connection request expired');
   }
   this.options.secrets.remove('pending:'+p.id);
   return p;
  });
  const service=this.options.factory.service(pending.serviceName,pending.capabilities,pending.workflow);
  if(callback.error) {service.reset();return {status:'blocked'}}
  if(!callback.code||callback.code.length>4096) {service.reset();throw new AppError('INVALID_CALLBACK','Connection callback is incomplete')}
  try {
   if(!service.exchange(callback)) {service.reset();return {status:'blocked'}}
   const identity=service.identity();
   if(!identity.emailVerified||!/^[A-Za-z0-9_-]{1,255}$/.test(identity.sub)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)) {
    throw new AppError('IDENTITY_UNVERIFIED','Google identity could not be verified');
   }
   if(pending.hint&&normalize(identity.email)!==pending.hint)throw new AppError('ACCOUNT_MISMATCH','Selected account does not match');
   const id='google:'+identity.sub;
   const previous=this.read(id);
   const granted=new Set(identity.scopes);
   const capabilities=pending.capabilities.filter(cap=>granted.has(GOOGLE_SCOPES[cap])&&
    (cap!=='classroom.read'||granted.has('https://www.googleapis.com/auth/classroom.courses.readonly')));
   if(pending.workflow==='agent'&&(!previous||previous.status!=='active'))throw new AppError('MANUAL_CONNECTION_REQUIRED','Connect this account for direct access first');
   const connection:PrivateConnection=pending.workflow==='agent'
    ? {...previous!,agentServiceName:pending.serviceName,backgroundCapabilities:capabilities,backgroundReady:true}
    : {id,subject:identity.sub,serviceName:pending.serviceName,email:normalize(identity.email),label:previous?.label??identity.email,status:'active',capabilities,paused:previous?.paused??false,...(previous?.agentServiceName?{agentServiceName:previous.agentServiceName,backgroundCapabilities:previous.backgroundCapabilities,backgroundReady:true}:{}),...(previous?.lastSync?{lastSync:previous.lastSync}:{})};
   this.options.secrets.atomic(()=>{
    this.options.secrets.set('connection:'+id,JSON.stringify(connection));
    const oldService=pending.workflow==='agent'?previous?.agentServiceName:previous?.serviceName;
    if(oldService&&oldService!==pending.serviceName)this.options.factory.service(oldService,undefined,pending.workflow).reset();
   });
   return {status:'connected',connection:view(connection)};
  } catch(e) {
   service.reset();
   if(e instanceof AppError)throw e;
   throw new AppError('CONNECTION_FAILED','Google connection could not be completed');
  }
 }
 listConnections(actor:string):ConnectionView[]{
  this.assertOwner(actor);
  return this.options.secrets.keys('connection:').map(key=>view(JSON.parse(this.options.secrets.get(key)!) as PrivateConnection));
 }
 access(id:string,capability:Capability,workflow:'manual'|'agent'='manual'):string {
  const c=this.read(id);
  if(!c||c.status!=='active')throw new AppError('NO_CONNECTION','Connection is not available');
  if(workflow==='agent'&&(!c.agentServiceName||c.paused))throw new AppError('BACKGROUND_GRANT_REQUIRED','Authorize background access for this account');
  const caps=workflow==='agent'?c.backgroundCapabilities??[]:c.capabilities;
  if(!caps.includes(capability))throw new AppError('MISSING_PERMISSION','This account has not granted the required permission');
  try {return this.options.factory.service(workflow==='agent'?c.agentServiceName!:c.serviceName,caps,workflow).accessToken()}
  catch {throw new AppError('RECONNECT_REQUIRED','Reconnect this Google account')}
 }
 pause(actor:string,id:string,paused:boolean):ConnectionView {
  this.assertOwner(actor);const c=this.read(id);if(!c)throw new AppError('NO_CONNECTION','Connection is not available');
  c.paused=paused;this.options.secrets.set('connection:'+id,JSON.stringify(c));return view(c);
 }
 disconnect(actor:string,id:string):ConnectionView {
  this.assertOwner(actor);const c=this.read(id);if(!c)throw new AppError('NO_CONNECTION','Connection is not available');
  this.options.factory.service(c.serviceName,undefined,'manual').reset();if(c.agentServiceName)this.options.factory.service(c.agentServiceName,undefined,'agent').reset();delete c.agentServiceName;c.backgroundReady=false;c.backgroundCapabilities=[];c.status='disconnected';c.capabilities=[];c.paused=true;
  this.options.secrets.set('connection:'+id,JSON.stringify(c));return view(c);
 }
 markSync(id:string,at:string,error?:string):void {
  const c=this.read(id);if(!c)return;
  if(error)c.error=error;else {c.lastSync=at;delete c.error}
  this.options.secrets.set('connection:'+id,JSON.stringify(c));
 }
 private read(id:string):PrivateConnection|null {const s=this.options.secrets.get('connection:'+id);return s?JSON.parse(s) as PrivateConnection:null}
}
