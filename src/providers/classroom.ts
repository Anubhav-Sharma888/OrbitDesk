import {AppError,type Clock,type SourceItem} from '../shared/contracts.js';
import {classroomDue} from '../tasks/deadlines.js';
import {providerId} from '../tasks/correlate.js';
import type {GoogleTransport} from './transport.js';
type Obj=Record<string,unknown>;
function object(v:unknown):Obj {if(!v||typeof v!=='object'||Array.isArray(v))throw new AppError('INVALID_PROVIDER_RESPONSE','Google returned invalid Classroom data');return v as Obj}
function array(v:unknown):Obj[]{if(v===undefined)return [];if(!Array.isArray(v)||v.length>100)throw new AppError('IMPORT_PAGE_LIMIT','Classroom returned an oversized page');return v.map(object)}
function next(v:unknown):string|undefined {if(v===undefined||v==='')return undefined;if(typeof v!=='string'||v.length>2000)throw new AppError('INVALID_PROVIDER_RESPONSE','Classroom returned an invalid page token');return v}
function query(size:number,pageToken?:string):string {if(!Number.isInteger(size)||size<1||size>100)throw new AppError('INVALID_INPUT','Choose a provider page size from 1 to 100');return 'pageSize='+size+(pageToken?'&pageToken='+encodeURIComponent(next(pageToken)!):'')}
export interface ClassroomCoursesPage {courseIds:string[];nextPageToken?:string}
export interface ClassroomWorkPage {items:SourceItem[];nextPageToken?:string}
export interface ClassroomSubmissionPage {states:Record<string,string>;nextPageToken?:string}
export class ClassroomAdapter {
 constructor(private transport:GoogleTransport,private clock:Clock){}
 courses(connectionId:string,pageToken?:string,size=20):ClassroomCoursesPage {
  const data=object(this.transport.request(connectionId,'classroom','/courses?studentId=me&courseStates=ACTIVE&'+query(size,pageToken),'classroom.read'));
  return {courseIds:array(data.courses).filter(c=>c.courseState===undefined||c.courseState==='ACTIVE').map(c=>providerId(String(c.id??''))),nextPageToken:next(data.nextPageToken)};
 }
 coursework(connectionId:string,courseId:string,pageToken?:string,size=20):ClassroomWorkPage {
  providerId(courseId);const data=object(this.transport.request(connectionId,'classroom','/courses/'+courseId+'/courseWork?courseWorkStates=PUBLISHED&'+query(size,pageToken),'classroom.read'));
  const items=array(data.courseWork).filter(w=>w.state==='PUBLISHED').map(w=>{
   const id=providerId(String(w.id??''));if(w.courseId!==undefined&&w.courseId!==courseId)throw new AppError('INVALID_PROVIDER_RESPONSE','Classroom returned coursework from another course');
   if(typeof w.title!=='string'||!w.title)throw new AppError('INVALID_PROVIDER_RESPONSE','Classroom returned coursework without a title');
   const stamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():this.clock.iso();
   return {connectionId,id,type:'classroom' as const,courseId,courseworkId:id,title:w.title.slice(0,3000),text:typeof w.description==='string'?w.description.slice(0,16000):'',officialDue:classroomDue(w.dueDate,w.dueTime),receivedAt:stamp(w.creationTime),updatedAt:stamp(w.updateTime),...(typeof w.alternateLink==='string'?{url:w.alternateLink.slice(0,2000)}:{})};
  });return {items,nextPageToken:next(data.nextPageToken)};
 }
 submissions(connectionId:string,courseId:string,courseworkId:string,pageToken?:string,size=20):ClassroomSubmissionPage {
  providerId(courseId);providerId(courseworkId);const data=object(this.transport.request(connectionId,'classroom','/courses/'+courseId+'/courseWork/'+courseworkId+'/studentSubmissions?userId=me&'+query(size,pageToken),'classroom.read'));
  const states:Record<string,string>={};for(const s of array(data.studentSubmissions)){if(s.courseId!==undefined&&s.courseId!==courseId||s.courseWorkId!==undefined&&s.courseWorkId!==courseworkId)throw new AppError('INVALID_PROVIDER_RESPONSE','Classroom returned another assignment submission');if(typeof s.state==='string'&&['NEW','CREATED','TURNED_IN','RETURNED','RECLAIMED_BY_STUDENT'].includes(s.state))states[courseworkId]=s.state}
  return {states,nextPageToken:next(data.nextPageToken)};
 }
}
