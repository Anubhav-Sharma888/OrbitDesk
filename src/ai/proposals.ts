import {z} from 'zod';
import {AppError,type ReplyDraft} from '../shared/contracts.js';
import type {GroqClient} from './groq.js';
export const proposalSchema=z.object({summary:z.string().max(2000),tasks:z.array(z.object({title:z.string().min(1).max(240),notes:z.string().max(2000)}).strict()).max(10),replyText:z.string().max(16000)}).strict();
export type AiProposal=z.infer<typeof proposalSchema>;
export const proposalJsonSchema={type:'object',properties:{summary:{type:'string'},tasks:{type:'array',items:{type:'object',properties:{title:{type:'string'},notes:{type:'string'}},required:['title','notes'],additionalProperties:false}},replyText:{type:'string'}},required:['summary','tasks','replyText'],additionalProperties:false};
export interface ProposalInput {connectionId:string;source:{connectionId:string;id:string;text:string};userContent?:string}
const inputSchema=z.object({connectionId:z.string().min(1).max(300),source:z.object({connectionId:z.string().min(1).max(300),id:z.string().min(1).max(300),text:z.string().max(12000)}).strict(),userContent:z.string().max(16000).optional()}).strict();
export class AiProposalService {
 constructor(private client:Pick<GroqClient,'complete'>){}
 rephrase(draft:ReplyDraft):AiProposal {
  if(draft.importedUnreviewed)throw new AppError('REVIEW_REQUIRED','Save and review this imported draft before rephrasing');
  if(!draft.userContent.trim())throw new AppError('USER_CONTENT_REQUIRED','Provide your own reply content before rephrasing');
  return this.propose({connectionId:draft.connectionId,source:{connectionId:draft.connectionId,id:draft.sourceId,text:draft.body},userContent:draft.userContent});
 }
 propose(input:ProposalInput):AiProposal {
  const parsed=inputSchema.safeParse(input);if(!parsed.success)throw new AppError('INVALID_INPUT','Choose one bounded source for the AI proposal');
  if(input.connectionId!==input.source.connectionId)throw new AppError('WRONG_IDENTITY','AI source must belong to the same account');
  const proposal=proposalSchema.safeParse(this.client.complete(JSON.stringify(parsed.data)));
  if(!proposal.success)throw new AppError('INVALID_AI_PROPOSAL','AI returned an invalid proposal');
  return proposal.data;
 }
}

