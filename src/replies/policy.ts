import {AppError,type Codec,type ReplyDraft} from '../shared/contracts.js';
export interface SendActor {kind:'user'|'source'|'ai';email:string}
export interface SendCommand {requestId:string;draftId:string;expectedVersion:number;instruction:string}
export function assertSendInstruction(actor:SendActor,command:SendCommand,owner:string):void {
 if(actor.kind!=='user'||!owner||actor.email.trim().toLowerCase()!==owner.trim().toLowerCase())throw new AppError('UNAUTHORIZED','Owner instruction is required to send a reply');
 if(command.instruction!=='send')throw new AppError('SEND_INSTRUCTION_REQUIRED','Give the explicit send instruction');
 if(!/^[-A-Za-z0-9_:.]{1,128}$/.test(command.requestId)||!Number.isSafeInteger(command.expectedVersion)||command.expectedVersion<1)throw new AppError('INVALID_INPUT','Invalid reply request');
}
const messageId=/^<[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/;
const controls=/[\x00-\x1f\x7f]/;
function foldedHeader(name:string,values:string[],separator:string):string {
 const lines:string[]=[];let line=name+': ';
 values.forEach((value,index)=>{const prefix=index?separator:'';if(index&&(line+prefix+value).length>78){lines.push(line+(separator===', '?',':''));line=' '+value}else line+=prefix+value});
 lines.push(line);return lines.join('\r\n');
}
export function replyMime(draft:ReplyDraft,codec:Codec):{raw:string;threadId:string} {
 if(draft.importedUnreviewed)throw new AppError('REVIEW_REQUIRED','Save and review this imported draft before sending');
 if(typeof draft.userContent!=='string'||!draft.userContent.trim())throw new AppError('USER_CONTENT_REQUIRED','Provide your own reply content before sending');
 if(typeof draft.body!=='string'||!draft.body.trim()||draft.body.length>16000||draft.userContent.length>16000)throw new AppError('INVALID_INPUT','Provide a reply within the content limit');
 if(!/^[-A-Za-z0-9_]{1,200}$/.test(draft.threadId))throw new AppError('INVALID_HEADER','Invalid reply thread');
 if(!draft.connectionId||!draft.sourceId)throw new AppError('INVALID_SOURCE','Reply needs a connected source message');
 if(!draft.to.length||draft.to.length>10||draft.to.some(v=>v.length>254||!/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v)))throw new AppError('INVALID_HEADER','Invalid reply header recipients');
 if(controls.test(draft.subject)||draft.subject.length>500||controls.test(draft.messageId)||draft.messageId.length>900||!messageId.test(draft.messageId))throw new AppError('INVALID_HEADER','Invalid reply header');
 if(controls.test(draft.references)||draft.references.length>8000)throw new AppError('INVALID_HEADER','Invalid reply header references');
 const references=draft.references.trim()?draft.references.trim().split(/ +/):[];
 if(references.length>100||references.some(v=>v.length>900||!messageId.test(v)))throw new AppError('INVALID_HEADER','Invalid reply header references');
 if(!references.includes(draft.messageId))references.push(draft.messageId);
 // Every header is validated before encoding. Body is encoded separately as UTF-8.
 const subject=draft.subject.replace(/^(?:re:\s*)+/i,'');
 const words:string[]=[];let word='';
 for(const character of Array.from('Re: '+subject)){if(codec.encodeBase64(word+character).length>60){words.push(codec.encodeBase64(word));word=''}word+=character}if(word)words.push(codec.encodeBase64(word));
 const subjectHeader=words.map(v=>'=?UTF-8?B?'+v+'?=').join('\r\n ');
 const body=codec.encodeBase64(draft.body).match(/.{1,76}/g)!.join('\r\n');
 const mime=[foldedHeader('To',draft.to,', '),'Subject: '+subjectHeader,'In-Reply-To: '+draft.messageId,foldedHeader('References',references,' '),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+body].join('\r\n');
 return {raw:codec.encodeBase64Url(mime),threadId:draft.threadId};
}


