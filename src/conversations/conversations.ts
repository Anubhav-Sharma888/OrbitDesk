import {AppError,type RecordStore,type Clock,type Ids,type Conversation,type ChatMessage} from '../shared/contracts.js';
type OrderedMessage=ChatMessage&{sequence:number};
export class ConversationService {
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids){}
 create(title:string):Conversation{
  if(!title.trim()||title.length>180)throw new AppError('INVALID_INPUT','Give the conversation a short title');
  const c:Conversation={id:this.ids.next(),title,version:1,createdAt:this.clock.iso(),updatedAt:this.clock.iso()};
  this.store.put('conversations',c.id,c,null);return c;
 }
 append(id:string,request:string,role:'user'|'assistant',text:string):ChatMessage{
  if(!text.trim()||text.length>12000||!['user','assistant'].includes(role))throw new AppError('INVALID_INPUT','Enter a message of up to 12,000 characters');
  return this.store.atomic(()=>{
   const fingerprint=this.ids.hash(JSON.stringify({id,role,text}));
   const previous=this.store.get<{fingerprint:string;message:ChatMessage}>('requests','message:'+request);
   if(previous){if(previous.data.fingerprint!==fingerprint)throw new AppError('IDEMPOTENCY_CONFLICT','This request was already used for a different operation');return previous.data.message}
   const conversation=this.store.get<Conversation>('conversations',id);
   if(!conversation)throw new AppError('NOT_FOUND','Conversation not found');
   const m:OrderedMessage={id:this.ids.next(),conversationId:id,role,text,version:1,sequence:conversation.version+1,createdAt:this.clock.iso()};
   this.store.put('messages',m.id,m,null);
   this.store.put('conversations',id,{...conversation.data,updatedAt:this.clock.iso()},conversation.version);
   this.store.put('requests','message:'+request,{fingerprint,message:m},null);
   return m;
  });
 }
 load(id:string,before?:string,limit=50):{conversation:Conversation;messages:ChatMessage[]}{
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new AppError('INVALID_INPUT','Choose a page size from 1 to 100');
  const row=this.store.get<Conversation>('conversations',id);if(!row)throw new AppError('NOT_FOUND','Conversation not found');
  let messages=this.store.list<OrderedMessage>('messages').map(r=>r.data).filter(m=>m.conversationId===id).sort((a,b)=>a.sequence-b.sequence);
  if(before){const at=messages.findIndex(m=>m.id===before);if(at<0)throw new AppError('INVALID_CURSOR','Conversation page is no longer available');messages=messages.slice(0,at)}
  return {conversation:{...row.data,version:row.version,updatedAt:row.updatedAt},messages:messages.slice(-limit)};
 }
}
