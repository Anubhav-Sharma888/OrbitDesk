import {AppError,type SecretStore,type Capability,type HttpPort,type HttpRequest,type HttpResponse,type Codec} from '../shared/contracts.js';
import {OAuthBroker,scopesFor,type OAuthFactory,type GoogleIdentity} from '../accounts/oauth.js';
declare const OAuth2:any;
let lock:GoogleAppsScript.Lock.Lock|undefined;
let depth=0;
export function scriptAtomic<T>(work:()=>T):T {
 if(depth){depth++;try{return work()}finally{depth--}}
 lock??=LockService.getScriptLock();
 if(!lock.tryLock(3000))throw new AppError('BUSY','Another operation is running; try again shortly');
 depth++;
 try{return work()}finally{depth--;lock.releaseLock()}
}
export class ScriptSecrets implements SecretStore {
 private properties=PropertiesService.getScriptProperties();
 get(key:string):string|null{return this.properties.getProperty(key)}
 set(key:string,value:string):void{this.properties.setProperty(key,value)}
 remove(key:string):void{this.properties.deleteProperty(key)}
 keys(prefix:string):string[]{return Object.keys(this.properties.getProperties()).filter(k=>k.startsWith(prefix))}
 atomic<T>(work:()=>T):T{return scriptAtomic(work)}
}
export class AppsHttp implements HttpPort {
 fetch(request:HttpRequest):HttpResponse {
  const response=UrlFetchApp.fetch(request.url,{method:request.method.toLowerCase() as GoogleAppsScript.URL_Fetch.HttpMethod,headers:request.headers,payload:request.body,muteHttpExceptions:true,followRedirects:false,validateHttpsCertificates:true});
  let json:unknown=null;try{const content=response.getContentText();json=content?JSON.parse(content):null}catch{json=null}
  const headers:Record<string,string>={};for(const [k,v]of Object.entries(response.getAllHeaders()))headers[k]=String(v);
  return {status:response.getResponseCode(),json,headers};
 }
}
export const appsClock={now:()=>Date.now(),iso:()=>new Date().toISOString()};
export const appsIds={next:()=>Utilities.getUuid(),hash:(value:string)=>Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8).map(v=>(v+256)%256).map(v=>v.toString(16).padStart(2,'0')).join('')};
export const appsCodec:Codec={
 encodeBase64Url:(s)=>Utilities.base64EncodeWebSafe(s,Utilities.Charset.UTF_8).replace(/=+$/,''),
 decodeBase64Url:(s)=>Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8'),
 encodeBase64:(s)=>Utilities.base64Encode(s,Utilities.Charset.UTF_8)
};
export function configuredOwner():string {
 const owner=PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL')??'';
 if(!owner)throw new AppError('SETUP_REQUIRED','Set the private owner email before deployment');
 return owner.toLowerCase();
}
export function requireOwner():string {
 const actor=Session.getActiveUser().getEmail().toLowerCase();
 if(!actor||actor!==configuredOwner())throw new AppError('UNAUTHORIZED','Owner access required');
 return actor;
}
export class AppsOAuthFactory implements OAuthFactory {
 service(name:string,capabilities:Capability[]=[],workflow:'manual'|'agent'='manual'){
  const properties=PropertiesService.getScriptProperties();
  const prefix=workflow==='agent'?'GOOGLE_AGENT':'GOOGLE';
  const clientId=properties.getProperty(prefix+'_CLIENT_ID'),clientSecret=properties.getProperty(prefix+'_CLIENT_SECRET');
  if(!clientId||!clientSecret)throw new AppError('SETUP_REQUIRED','Google sign-in credentials need configuration');
  lock??=LockService.getScriptLock();
  const service=OAuth2.createService(name)
   .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/v2/auth')
   .setTokenUrl('https://oauth2.googleapis.com/token')
   .setClientId(clientId).setClientSecret(clientSecret).setCallbackFunction('authCallback')
   .setScope(scopesFor(capabilities).join(' ')).setParam('access_type','offline')
   .setParam('prompt','consent select_account').setParam('include_granted_scopes','true')
   .setPropertyStore(properties).setCache(CacheService.getScriptCache()).setLock(lock);
  return {
   authorizationUrl:(params:Record<string,string>)=>{service.generateCodeVerifier().setCodeChallengeMethod('S256');return service.getAuthorizationUrl(params) as string},
   exchange:(callback:Record<string,string>)=>service.handleCallback({parameter:callback}) as boolean,
   identity:():GoogleIdentity=>{
    const response=new AppsHttp().fetch({url:'https://openidconnect.googleapis.com/v1/userinfo',method:'GET',headers:{Authorization:'Bearer '+service.getAccessToken()},followRedirects:false});
    if(response.status!==200||!response.json||typeof response.json!=='object')throw new AppError('IDENTITY_UNVERIFIED','Google identity could not be verified');
    const info=response.json as Record<string,unknown>;
    const token=service.getToken();
    return {sub:typeof info.sub==='string'?info.sub:'',email:typeof info.email==='string'?info.email:'',emailVerified:info.email_verified===true,scopes:typeof token?.scope==='string'?token.scope.split(/\s+/):[]};
   },
   accessToken:()=>service.getAccessToken() as string,
   reset:()=>{service.reset()}
  };
 }
}
export function productionBroker():OAuthBroker {return new OAuthBroker({owner:configuredOwner(),secrets:new ScriptSecrets(),factory:new AppsOAuthFactory(),clock:appsClock,ids:appsIds})}
export function safeError(error:unknown):{code:string;message:string} {
 return error instanceof AppError?{code:error.code,message:error.message}:{code:'INTERNAL_ERROR',message:'The operation could not be completed'};
}
