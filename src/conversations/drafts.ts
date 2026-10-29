import {AppError,type RecordStore,type Clock,type Ids,type SourceItem,type ReplyDraft} from '../shared/contracts.js';
export class DraftService {
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids){}
 create(source:SourceItem,userContent:string):ReplyDraft{
  if(source.type!=='gmail'||!source.threadId||!source.rfcMessageId||!source.sender)throw new AppError('INVALID_SOURCE','Choose a verified Gmail message with reply information');
  const to=(source.sender.match(/<([^<>]+)>/)?.[1]??source.sender).trim();
  const draft:ReplyDraft={id:this.ids.next(),version:1,connectionId:source.connectionId,sourceId:source.id,threadId:source.threadId,messageId:source.rfcMessageId,references:source.references??source.rfcMessageId,subject:source.title,to:[to],body:userContent,userContent,status:'draft',rephrased:false,createdAt:this.clock.iso(),updatedAt:this.clock.iso()};
  this.store.put('drafts',draft.id,draft,null);return draft;
 }
 get(id:string):ReplyDraft {
  const row=this.store.get<ReplyDraft>('drafts',id);if(!row)throw new AppError('NOT_FOUND','Reply draft not found');
  return {...row.data,id:row.id,version:row.version,updatedAt:row.updatedAt};
 }
 save(id:string,version:number,patch:{to:string[];body:string;userContent:string}):ReplyDraft {
  return this.store.atomic(()=>{
   const current=this.get(id);
   if(['pending','unknown','sent'].includes(current.status))throw new AppError('DRAFT_LOCKED','This reply has been submitted; create a new draft');
   if(patch.body.length>16000||patch.userContent.length>16000||!patch.to.length||patch.to.length>10||patch.to.some(a=>!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)||a.length>254))throw new AppError('INVALID_INPUT','Check reply recipients and content length');
   const next={...current,...patch,status:'draft' as const,rephrased:false,importedUnreviewed:false,updatedAt:this.clock.iso()};
   const row=this.store.put('drafts',id,next,version);
   return {...next,version:row.version};
  });
 }
}
