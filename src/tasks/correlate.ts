import {AppError,type SourceItem,type SourceRef} from '../shared/contracts.js';
export function providerId(id:string):string {if(typeof id!=='string'||!/^[-A-Za-z0-9_]{1,120}$/.test(id))throw new AppError('INVALID_SOURCE','Invalid provider identifier');return id}
export function sourceConnectionId(id:string):string {if(typeof id!=='string'||! /^(?:[-A-Za-z0-9_]{1,120}|google:[-A-Za-z0-9_]{1,100})$/.test(id))throw new AppError('INVALID_SOURCE','Invalid source account identifier');return id}
export function sourceKey(s:Pick<SourceItem,'connectionId'|'type'|'id'|'courseId'|'courseworkId'>):string {const account=sourceConnectionId(s.connectionId);return s.type==='gmail'?'gmail:'+account+':'+providerId(s.id):'classroom:'+account+':'+providerId(s.courseId??'')+':'+providerId(s.courseworkId??s.id)}
export function sourceRef(s:SourceItem):SourceRef {return {connectionId:s.connectionId,type:s.type,id:s.id,...(s.courseId?{courseId:s.courseId}:{}),...(s.courseworkId?{courseworkId:s.courseworkId}:{}),...(s.url?{url:s.url}:{})}}
// Match observed Classroom alternateLink identities, never titles or decoded guesses about opaque web IDs.
export function assignmentLink(value:string):string|null {
 const m=value.match(/^https:\/\/classroom\.google\.com(?:\/u\/\d+)?\/c\/([-A-Za-z0-9_]+)\/a\/([-A-Za-z0-9_]+)(?:\/(?:details|submissions))?(?:[?#][^\s<>"']*)?$/);
 return m?'https://classroom.google.com/c/'+m[1]+'/a/'+m[2]:null;
}
export function exactClassroomMatch(mail:SourceItem,work:SourceItem):boolean {
 if(mail.type!=='gmail'||work.type!=='classroom'||mail.connectionId!==work.connectionId||!work.courseId||!work.courseworkId||!work.url)return false;
 const canonical=assignmentLink(work.url);if(!canonical)return false;
 const links=(mail.text+'\n'+(mail.url??'')).match(/https:\/\/classroom\.google\.com[^\s<>"']*/g)??[];
 const assignments=[...new Set(links.map(x=>assignmentLink(x.replace(/[).,;]+$/,''))).filter((x):x is string=>x!==null))];
 return assignments.length===1&&assignments[0]===canonical;
}

