import {AppError,type Clock,type Codec,type SourceItem} from '../shared/contracts.js';
import {providerId,sourceConnectionId} from '../tasks/correlate.js';
import type {GoogleTransport} from './transport.js';
type Obj=Record<string,unknown>;
function object(v:unknown):Obj {if(!v||typeof v!=='object'||Array.isArray(v))throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned an invalid message response');return v as Obj}
function token(v:unknown):string|undefined {if(v===undefined||v==='')return undefined;if(typeof v!=='string'||v.length>2000)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned an invalid page token');return v}
function opaque(v:unknown):string {if(typeof v!=='string'||!v||v.length>200)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned an invalid sync checkpoint');return v}
function ids(value:unknown):string[]{if(value===undefined)return [];if(!Array.isArray(value)||value.length>200)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned too many message identifiers');return value.map(v=>providerId(String(object(v).id??'')))}
function pageSize(n:number):number {if(!Number.isInteger(n)||n<1||n>100)throw new AppError('INVALID_INPUT','Choose a provider page size from 1 to 100');return n}
export interface GmailListPage {ids:string[];nextPageToken?:string}
export interface GmailHistoryPage extends GmailListPage {historyId:string}
export class GmailAdapter {
 constructor(private transport:GoogleTransport,private codec:Codec,private clock:Clock){}
 profile(connectionId:string):string {return opaque(object(this.transport.request(connectionId,'gmail','/users/me/profile','mail.read')).historyId)}
 list(connectionId:string,pageToken?:string,size=20):GmailListPage {
  const path='/users/me/messages?maxResults='+pageSize(size)+'&q='+encodeURIComponent('newer_than:30d')+(pageToken?'&pageToken='+encodeURIComponent(token(pageToken)!):'');
  const data=object(this.transport.request(connectionId,'gmail',path,'mail.read'));return {ids:ids(data.messages),nextPageToken:token(data.nextPageToken)};
 }
 history(connectionId:string,startHistoryId:string,pageToken?:string,size=20):GmailHistoryPage {
  const path='/users/me/history?maxResults='+pageSize(size)+'&startHistoryId='+encodeURIComponent(opaque(startHistoryId))+(pageToken?'&pageToken='+encodeURIComponent(token(pageToken)!):'');
  const data=object(this.transport.request(connectionId,'gmail',path,'mail.read'));const entries=data.history??[];
  if(!Array.isArray(entries)||entries.length>100)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned an invalid history page');
  const found=new Set<string>();
  for(const value of entries){const row=object(value);for(const group of ['messages','messagesAdded','labelsAdded','labelsRemoved']){const values=row[group]??[];if(!Array.isArray(values)||values.length>200)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned an invalid history change');for(const v of values){const item=object(v);const message=group==='messages'?item:object(item.message);found.add(providerId(String(message.id??'')));if(found.size>200)throw new AppError('IMPORT_PAGE_LIMIT','This Gmail change page exceeds the local bounded queue')}}}
  return {ids:[...found],historyId:opaque(data.historyId),nextPageToken:token(data.nextPageToken)};
 }
 message(connectionId:string,id:string):SourceItem {
  sourceConnectionId(connectionId);providerId(id);
  const data=object(this.transport.request(connectionId,'gmail','/users/me/messages/'+id+'?format=full','mail.read'));
  if(data.id!==id)throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned a different message');
  const payload=data.payload===undefined?{}:object(data.payload);const headers=Array.isArray(payload.headers)?payload.headers:[];
  const header=(name:string)=>{const h=headers.map(object).find(h=>String(h.name).toLowerCase()===name);return typeof h?.value==='string'?h.value.slice(0,2000):''};
  const milliseconds=typeof data.internalDate==='string'&&/^\d{1,16}$/.test(data.internalDate)?Number(data.internalDate):NaN;
  const received=Number.isFinite(milliseconds)&&Number.isFinite(new Date(milliseconds).getTime())?new Date(milliseconds).toISOString():this.clock.iso();
  return {connectionId,id,type:'gmail',title:(header('subject')||'(No subject)').slice(0,3000),text:this.mimeText(payload),receivedAt:received,updatedAt:this.clock.iso(),sender:header('from'),threadId:typeof data.threadId==='string'?providerId(data.threadId):id,rfcMessageId:header('message-id'),references:header('references')};
 }
 private mimeText(payload:Obj):string {
  const plain:string[]=[],html:string[]=[];let visited=0,plainTotal=0,htmlTotal=0;
  const visit=(part:Obj,depth:number):void=>{if(depth>20||++visited>100)return;if(typeof part.filename==='string'&&part.filename)return;
   const mime=String(part.mimeType??'').toLowerCase(),body=part.body===undefined?{}:object(part.body);
   if((mime==='text/plain'||mime==='text/html')&&typeof body.data==='string'&&!body.attachmentId){
    if(body.data.length>1000000)throw new AppError('IMPORT_MESSAGE_LIMIT','This message body exceeds local import limits');let value:string;try{value=this.codec.decodeBase64Url(body.data)}catch{throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned invalid message text')}
    value=value.slice(0,16000-(mime==='text/plain'?plainTotal:htmlTotal));if(mime==='text/plain')plainTotal+=value.length;else htmlTotal+=value.length;(mime==='text/plain'?plain:html).push(value);
   }
   if(Array.isArray(part.parts))for(const child of part.parts)visit(object(child),depth+1);
  };visit(payload,0);
  if(plain.length)return plain.join('\n').slice(0,16000);
  return html.join('\n').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,' $1 ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[x]??x)).replace(/[ \t]+/g,' ').trim().slice(0,16000);
 }
}


