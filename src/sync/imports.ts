import {AppError,type Clock,type RecordStore,type SourceItem} from '../shared/contracts.js';
import type {GmailAdapter} from '../providers/gmail.js';
import type {ClassroomAdapter} from '../providers/classroom.js';
import type {TaskService} from '../tasks/task-service.js';
import {sourceConnectionId,sourceKey} from '../tasks/correlate.js';
export interface ImportBounds {maxRequests?:number;pageSize?:number;initialLimit?:number}
export interface ImportResult {requests:number;imported:number;hasMore:boolean;deferredUntil?:number}
interface PendingMail {ids:string[];nextPageToken?:string;historyId?:string;initialCount?:number;initialDone?:boolean}
export interface GmailSyncState {mode:'initial'|'history';anchor?:string;historyId?:string;pageToken?:string;initialCount:number;initialLimit?:number;pageSize?:number;pending?:PendingMail;deferredUntil?:number;lastCompletedAt?:string}
interface PendingWork {keys:string[];nextPageToken?:string;submissionPageToken?:string;submissionState?:string}
export interface ClassroomSyncState {courseIds:string[];coursesPageToken?:string;coursesComplete:boolean;workPageToken?:string;pending?:PendingWork;pageSize?:number;complete?:boolean;deferredUntil?:number;lastCompletedAt?:string}
function bounds(opts:ImportBounds):Required<ImportBounds> {const v={maxRequests:opts.maxRequests??12,pageSize:opts.pageSize??20,initialLimit:opts.initialLimit??200};if(!Number.isInteger(v.maxRequests)||v.maxRequests<1||v.maxRequests>50||!Number.isInteger(v.pageSize)||v.pageSize<1||v.pageSize>100||!Number.isInteger(v.initialLimit)||v.initialLimit<1||v.initialLimit>500)throw new AppError('INVALID_INPUT','Choose a bounded import request and page limit');return v}
export class ImportService {
 constructor(private store:RecordStore,private gmail:GmailAdapter,private classroom:ClassroomAdapter,private tasks:TaskService,private clock:Clock){}
 gmailState(connectionId:string):GmailSyncState {sourceConnectionId(connectionId);return this.store.get<GmailSyncState>('sync','gmail:'+connectionId)?.data??{mode:'initial',initialCount:0}}
 classroomState(connectionId:string):ClassroomSyncState {sourceConnectionId(connectionId);return this.store.get<ClassroomSyncState>('sync','classroom:'+connectionId)?.data??{courseIds:[],coursesComplete:false}}
  syncGmail(connectionId:string,options:ImportBounds={}):ImportResult {
  sourceConnectionId(connectionId);const b=bounds(options),key='gmail:'+connectionId;let state=this.gmailState(connectionId);const result:ImportResult={requests:0,imported:0,hasMore:true};
  if((state.deferredUntil??0)>this.clock.now())return {...result,deferredUntil:state.deferredUntil};
  let version=this.store.get('sync',key)?.version??null;const save=()=>{const row=this.store.put('sync',key,state,version);version=row.version};
  try {
   while(true){
    if(state.pending){
     const pending=state.pending;
     if(pending.ids.length){
      if(result.requests>=b.maxRequests)break;
      const id=pending.ids[0];result.requests++;
      let source:SourceItem|undefined;try{source=this.gmail.message(connectionId,id)}catch(e){if(!(e instanceof AppError)||e.code!=='NOT_FOUND')throw e}
      this.store.atomic(()=>{if(source){this.tasks.importSource(source);result.imported++}state={...state,pending:{...pending,ids:pending.ids.slice(1)}};save()});continue;
     }
     if(state.mode==='initial'){
      state={...state,initialCount:pending.initialCount??state.initialCount,pageToken:pending.nextPageToken,pending:undefined};
      if(pending.initialDone){state={...state,mode:'history',historyId:state.anchor,pageToken:undefined,anchor:undefined,lastCompletedAt:this.clock.iso()};save();result.hasMore=false;break}
     }else{
      state={...state,pageToken:pending.nextPageToken,pending:undefined};
      if(!pending.nextPageToken){state={...state,historyId:pending.historyId??state.historyId,lastCompletedAt:this.clock.iso()};save();result.hasMore=false;break}
     }
     save();continue;
    }
    if(result.requests>=b.maxRequests)break;
    if(state.mode==='initial'){
     if(!state.anchor){result.requests++;const anchor=this.gmail.profile(connectionId);state={...state,anchor,initialCount:0,initialLimit:b.initialLimit,pageSize:b.pageSize};save();continue}
     result.requests++;const page=this.gmail.list(connectionId,state.pageToken,state.pageSize??b.pageSize);
     const remaining=(state.initialLimit??b.initialLimit)-state.initialCount,selected=page.ids.slice(0,remaining),count=state.initialCount+selected.length;
     state={...state,pending:{ids:selected,initialCount:count,nextPageToken:page.nextPageToken,initialDone:!page.nextPageToken||count>=(state.initialLimit??b.initialLimit)}};save();continue;
    }
    result.requests++;
    try{
     const page=this.gmail.history(connectionId,state.historyId??'',state.pageToken,state.pageSize??b.pageSize);
     state={...state,pageSize:state.pageSize??b.pageSize,pending:{ids:page.ids,nextPageToken:page.nextPageToken,historyId:page.historyId}};save();
    }catch(e){
     if(e instanceof AppError&&(e.code==='NOT_FOUND'||e.code==='CURSOR_EXPIRED')){state={mode:'initial',initialCount:0};save();continue}throw e;
    }
   }
  }catch(e){if(e instanceof AppError&&e.code==='RATE_LIMITED'){state={...state,deferredUntil:this.clock.now()+(e.retryAfterSeconds??60)*1000};save();result.deferredUntil=state.deferredUntil}else throw e}
  return result;
 }
 syncClassroom(connectionId:string,options:ImportBounds={}):ImportResult {
  sourceConnectionId(connectionId);const b=bounds(options),key='classroom:'+connectionId;let state=this.classroomState(connectionId);const result:ImportResult={requests:0,imported:0,hasMore:true};
  if((state.deferredUntil??0)>this.clock.now())return {...result,deferredUntil:state.deferredUntil};
  if(state.complete)state={courseIds:[],coursesComplete:false,pageSize:b.pageSize,lastCompletedAt:state.lastCompletedAt};
  state.pageSize=state.pageSize??b.pageSize;let version=this.store.get('sync',key)?.version??null;const save=()=>{const row=this.store.put('sync',key,state,version);version=row.version};
  try {
   while(true){
    if(state.pending){
     const pending=state.pending;
     if(pending.keys.length){
      if(result.requests>=b.maxRequests)break;
      const itemKey=pending.keys[0],staged=this.store.get<{source:SourceItem}>('import-items',itemKey);if(!staged)throw new AppError('IMPORT_QUEUE_CORRUPT','A queued Classroom item needs recovery');
      const source=staged.data.source;result.requests++;
      const page=this.classroom.submissions(connectionId,source.courseId!,source.courseworkId!,pending.submissionPageToken,state.pageSize);
      const officialState=page.states[source.courseworkId!]??pending.submissionState;
      if(page.nextPageToken){state={...state,pending:{...pending,submissionPageToken:page.nextPageToken,submissionState:officialState}};save();continue}
      this.store.atomic(()=>{
       this.tasks.importSource({...source,...(officialState?{submissionState:officialState}:{})});result.imported++;
       this.store.remove('import-items',itemKey,staged.version);
       state={...state,pending:{...pending,keys:pending.keys.slice(1),submissionPageToken:undefined,submissionState:undefined}};save();
      });continue;
     }
     state={...state,pending:undefined,workPageToken:pending.nextPageToken,...(!pending.nextPageToken?{courseIds:state.courseIds.slice(1)}:{})};save();continue;
    }
    if(!state.courseIds.length&&state.coursesComplete){state={...state,complete:true,lastCompletedAt:this.clock.iso()};save();result.hasMore=false;break}
    if(result.requests>=b.maxRequests)break;
    if(!state.courseIds.length){
     result.requests++;const page=this.classroom.courses(connectionId,state.coursesPageToken,state.pageSize);
     state={...state,courseIds:page.courseIds,coursesPageToken:page.nextPageToken,coursesComplete:!page.nextPageToken};save();continue;
    }
    result.requests++;const page=this.classroom.coursework(connectionId,state.courseIds[0],state.workPageToken,state.pageSize);
    this.store.atomic(()=>{
     const keys:string[]=[];for(const source of page.items){const itemKey=sourceKey(source),old=this.store.get('import-items',itemKey);this.store.put('import-items',itemKey,{source},old?.version??null);keys.push(itemKey)}
     state={...state,pending:{keys,nextPageToken:page.nextPageToken}};save();
    });
   }
  }catch(e){if(e instanceof AppError&&e.code==='RATE_LIMITED'){state={...state,deferredUntil:this.clock.now()+(e.retryAfterSeconds??60)*1000};save();result.deferredUntil=state.deferredUntil}else throw e}
  return result;
 }
}


