import {AppError,type Capability,type HttpPort} from '../shared/contracts.js';
import type {OAuthBroker} from '../accounts/oauth.js';
export type GoogleApi='gmail'|'calendar'|'classroom';
const origins:Record<GoogleApi,string>={gmail:'https://gmail.googleapis.com/gmail/v1',calendar:'https://www.googleapis.com/calendar/v3',classroom:'https://classroom.googleapis.com/v1'};
export class GoogleTransport {
 constructor(private broker:OAuthBroker,private http:HttpPort,private workflow:'manual'|'agent'='manual'){}
 request(connection:string,api:GoogleApi,path:string,cap:Capability,method:'GET'|'POST'|'PATCH'|'DELETE'='GET',body?:unknown,extraHeaders:Record<string,string>={}):unknown {
  if(!origins[api]||!path.startsWith('/')||path.startsWith('//')||/[\\\r\n#]/.test(path)||path.includes('://')||/(?:^|\/)\.\.(?:\/|$)|%2e|%2f|%5c/i.test(path.split('?')[0]))throw new AppError('INVALID_PATH','Unsupported provider path');
  if(api==='gmail'&&!path.startsWith('/users/me/'))throw new AppError('WRONG_IDENTITY','Gmail requests must use the connected identity');
  const cleanPath=path.split('?')[0];
  const allowed=api==='gmail' ? (method==='GET'&&cap==='mail.read'&&/^\/users\/me\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|history)$/.test(cleanPath))||
   (method==='POST'&&cap==='mail.send'&&cleanPath==='/users/me/messages/send') :
   api==='classroom' ? method==='GET'&&cap==='classroom.read'&&/^\/courses(?:\/[A-Za-z0-9_-]+\/courseWork(?:\/[A-Za-z0-9_-]+\/studentSubmissions)?)?$/.test(cleanPath) :
   (method==='GET'&&cap==='calendar.list'&&cleanPath==='/users/me/calendarList')||
   (/^\/calendars\/[^/]+\/events(?:\/[a-v0-9]+)?$/.test(cleanPath)&&((method==='GET'&&(cap==='calendar.read'||cap==='calendar.write'))||(method!=='GET'&&cap==='calendar.write')));
  if(!allowed)throw new AppError('INVALID_PATH','Unsupported provider path');
  for(const [key,value] of Object.entries(extraHeaders))if(key.toLowerCase()!=='if-match'||/[\r\n]/.test(value))throw new AppError('INVALID_HEADER','Unsupported request header');
  const token=this.broker.access(connection,cap,this.workflow);
  let response;
  try {response=this.http.fetch({url:origins[api]+path,method,headers:{...extraHeaders,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),followRedirects:false})}
  catch {throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the request result')}
  if(response.status>=200&&response.status<300)return response.json;
  const retryHeader=Object.entries(response.headers??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
  const seconds=Number(retryHeader);
  if(response.status===429)throw new AppError('RATE_LIMITED','Google usage limit reached',Number.isFinite(seconds)&&seconds>0?Math.min(seconds,3600):60);
  if(response.status===401)throw new AppError('RECONNECT_REQUIRED','Reconnect this Google account');
  if(response.status===403)throw new AppError('PROVIDER_FORBIDDEN','Google has not permitted this operation');
  if(response.status===404)throw new AppError('NOT_FOUND','The Google item is no longer available');
  if(response.status===409)throw new AppError('ALREADY_EXISTS','The Google item already exists');
  if(response.status===410)throw new AppError('CURSOR_EXPIRED','The Google sync checkpoint expired');
  if(response.status===412)throw new AppError('REMOTE_CONFLICT','This Google item changed elsewhere');
  if(response.status>=300&&response.status<400)throw new AppError('REDIRECT_REJECTED','Google returned an unsupported redirect');
  throw new AppError('PROVIDER_FAILED','Google could not complete this operation');
 }
}
