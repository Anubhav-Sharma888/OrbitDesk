import {AppError,type Clock,type Codec,type Ids,type RecordStore,type ReplyDraft} from '../shared/contracts.js';
import type {GoogleTransport} from '../providers/transport.js';
import {assertSendInstruction,replyMime,type SendActor,type SendCommand} from './policy.js';
export interface ReplySendPort {send(connectionId:string,payload:{raw:string;threadId:string}):{id:string;threadId?:string}}
export class GmailReplyPort implements ReplySendPort {
 constructor(private transport:Pick<GoogleTransport,'request'>){}
 send(connectionId:string,payload:{raw:string;threadId:string}):{id:string;threadId?:string}{
  const result=this.transport.request(connectionId,'gmail','/users/me/messages/send','mail.send','POST',payload);
  if(!result||typeof result!=='object'||typeof (result as any).id!=='string'||!(result as any).id)throw new AppError('NETWORK_UNCERTAIN','Gmail did not confirm the sent message');
  const response=result as {id:string;threadId?:unknown};
  if(response.threadId!==undefined&&response.threadId!==payload.threadId)throw new AppError('NETWORK_UNCERTAIN','Gmail did not confirm the reply thread');
  return {id:response.id,...(typeof response.threadId==='string'?{threadId:response.threadId}:{})};
 }
}
interface SendOperation {command:SendCommand;status:'pending'|'unknown'|'sent'|'failed';connectionId:string;threadId:string;draftVersion:number;remoteId?:string}
export class ReplyService {
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids,private codec:Codec,private port:ReplySendPort,private owner:string){}
 send(actor:SendActor,command:SendCommand):ReplyDraft {
  // The actor is constructed by the owner-guarded RPC route, never parsed from source or AI data.
  assertSendInstruction(actor,command,this.owner);
  const operationId='send:'+this.ids.hash(command.requestId);
  const prepared=this.store.atomic(()=>{
   const previous=this.store.get<SendOperation>('send_requests',operationId);
   if(previous){if(JSON.stringify(previous.data.command)!==JSON.stringify(command))throw new AppError('REQUEST_CONFLICT','This request was already used for a different operation');return {draft:this.get(command.draftId),duplicate:true,payload:null}}
   const draft=this.get(command.draftId);
   if(['pending','unknown','sent'].includes(draft.status))throw new AppError('DRAFT_LOCKED','This reply has been submitted; create a new draft');
   if(draft.version!==command.expectedVersion)throw new AppError('VERSION_CONFLICT','This item changed on another device');
   const payload=replyMime(draft,this.codec);
   const saved=this.store.put('drafts',draft.id,{...draft,status:'pending',updatedAt:this.clock.iso()},draft.version);
   this.store.put<SendOperation>('send_requests',operationId,{command:{...command},status:'pending',connectionId:draft.connectionId,threadId:draft.threadId,draftVersion:saved.version},null);
   return {draft:{...draft,status:'pending' as const,version:saved.version,updatedAt:saved.updatedAt},duplicate:false,payload};
  });
  if(prepared.duplicate)return prepared.draft;
  let status:'sent'|'unknown'|'failed'='unknown',remoteId:string|undefined;
  try {const result=this.port.send(prepared.draft.connectionId,prepared.payload!);if(!result.id)throw new AppError('NETWORK_UNCERTAIN','Gmail did not confirm the sent message');remoteId=result.id;status='sent'}
  catch(error){
   // Only definitive local/HTTP rejection is safe to label failed. Any other outcome may have delivered.
   const rejected=new Set(['NO_CONNECTION','MISSING_PERMISSION','RECONNECT_REQUIRED','PROVIDER_FORBIDDEN','RATE_LIMITED','INVALID_PATH','WRONG_IDENTITY']);
   if(error instanceof AppError&&rejected.has(error.code))status='failed';
  }
  return this.store.atomic(()=>{
   const operation=this.store.get<SendOperation>('send_requests',operationId)!;
   const draft=this.get(command.draftId);
   if(operation.data.status!=='pending'||draft.status!=='pending')return draft;
   const row=this.store.put('drafts',draft.id,{...draft,status,updatedAt:this.clock.iso()},draft.version);
   this.store.put('send_requests',operationId,{...operation.data,status,...(remoteId?{remoteId}:{})},operation.version);
   return {...draft,status,version:row.version,updatedAt:row.updatedAt};
  });
 }
 private get(id:string):ReplyDraft {const row=this.store.get<ReplyDraft>('drafts',id);if(!row)throw new AppError('NOT_FOUND','Reply draft not found');return {...row.data,id:row.id,version:row.version,updatedAt:row.updatedAt}}
}
