import {AppError,type Clock,type Due,type Ids,type RecordStore,type RouteDecision,type SourceItem,type SourceRef,type Task} from '../shared/contracts.js';
import {extractEmailDue,validateDue} from './deadlines.js';
import {exactClassroomMatch,sourceKey,sourceRef} from './correlate.js';
export interface CreateTask {title:string;notes?:string;officialDue?:Due;plannedDue?:Due}
export interface TaskPatch {title?:string;notes?:string;officialDue?:Due;override?:RouteDecision}
type Controls={title?:boolean;notes?:boolean};
function text(value:string,max:number,label:string):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new AppError('INVALID_INPUT','Enter '+label+' of up to '+max+' characters');return value}
function decision(d:RouteDecision):RouteDecision {if(!d||!['automatic','review','ignore'].includes(d.mode)||!Array.isArray(d.destinations)||d.destinations.length>9||d.destinations.some(x=>!x||typeof x.connectionId!=='string'||typeof x.calendarId!=='string'||!x.connectionId||!x.calendarId))throw new AppError('INVALID_INPUT','Choose explicit calendar destinations');return d}
export class TaskService {
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids){}
 list():Task[]{return this.store.list<Task>('tasks').map(r=>({...r.data,version:r.version,updatedAt:r.updatedAt}))}
 get(id:string):Task {const row=this.store.get<Task>('tasks',id);if(!row)throw new AppError('NOT_FOUND','Task not found');return {...row.data,version:row.version,updatedAt:row.updatedAt}}
 create(input:CreateTask):Task {
  const title=text(input.title,300,'a task title'),notes=input.notes??'';if(typeof notes!=='string'||notes.length>12000)throw new AppError('INVALID_INPUT','Use up to 12,000 characters for task notes');
  const task:Task={id:this.ids.next(),version:1,title,notes,status:'open',kind:'manual',officialDue:validateDue(input.officialDue??{kind:'unknown'}),...(input.plannedDue?{plannedDue:validateDue(input.plannedDue)}:{}),sourceRefs:[],confidence:'clear',createdAt:this.clock.iso(),updatedAt:this.clock.iso()};
  this.store.put('tasks',task.id,task,null);return task;
 }
 private mutate(id:string,version:number,change:(t:Task)=>Task):Task {return this.store.atomic(()=>{const t=this.get(id);if(t.version!==version)throw new AppError('VERSION_CONFLICT','This item changed on another device');const next=change(t);const row=this.store.put('tasks',id,{...next,version:version+1,updatedAt:this.clock.iso()},version);return {...row.data,version:row.version,updatedAt:row.updatedAt}})}
 edit(id:string,version:number,patch:TaskPatch):Task {return this.store.atomic(()=>this.mutate(id,version,t=>{
  if(Object.keys(patch).some(k=>!['title','notes','officialDue','override'].includes(k)))throw new AppError('INVALID_INPUT','Unsupported task change');
  const controls=this.store.get<Controls>('task-controls',id);const c=controls?.data??{};
  if(patch.title!==undefined){t.title=text(patch.title,300,'a task title');c.title=true}
  if(patch.notes!==undefined){if(typeof patch.notes!=='string'||patch.notes.length>12000)throw new AppError('INVALID_INPUT','Use up to 12,000 characters for task notes');t.notes=patch.notes;c.notes=true}
  if(patch.officialDue!==undefined){if(t.kind!=='manual')throw new AppError('OFFICIAL_DUE_READ_ONLY','Use your planned date to reschedule imported work');t.officialDue=validateDue(patch.officialDue)}
  if(patch.override!==undefined)t.override=decision(patch.override);
  this.store.put('task-controls',id,c,controls?.version??null);return t;
 }))}
 dismiss(id:string,version:number):Task{return this.mutate(id,version,t=>({...t,status:'dismissed'}))}
 restore(id:string,version:number):Task{return this.mutate(id,version,t=>({...t,status:'open'}))}
 complete(id:string,version:number):Task{return this.mutate(id,version,t=>({...t,status:'complete'}))}
 reschedule(id:string,version:number,due:Due|null):Task{return this.mutate(id,version,t=>{if(due===null)delete t.plannedDue;else t.plannedDue=validateDue(due);return t})}
 importSource(source:SourceItem):Task|null {return this.store.atomic(()=>{
  const key=sourceKey(source),row=this.store.get<SourceItem>('sources',key);
  if(row&&Date.parse(row.data.updatedAt)>Date.parse(source.updatedAt))return this.list().find(t=>t.sourceRefs.some(ref=>sourceKey(ref)===key))??null;
  if(!source.title||source.title.length>3000||typeof source.text!=='string'||source.text.length>16000)throw new AppError('INVALID_SOURCE','Imported source exceeds local limits');
  const stored={...source,...(source.officialDue?{officialDue:validateDue(source.officialDue)}:{})};
  this.store.put('sources',key,stored,row?.version??null);
  const all=this.store.list<SourceItem>('sources').map(r=>r.data);
  const assignments=source.type==='classroom'?[source]:all.filter(w=>exactClassroomMatch(source,w));
  // Ambiguous assignment identities require separate review even when a reused link happens to match.
  const assignment=assignments.length===1?assignments[0]:undefined;
  const related=assignment?[assignment,...all.filter(s=>exactClassroomMatch(s,assignment)&&all.filter(w=>exactClassroomMatch(s,w)).length===1)]:[source];
  const keys=new Set(related.map(sourceKey));
  const existing=this.list().filter(t=>t.sourceRefs.some(s=>keys.has(sourceKey(s)))&&(!assignment||t.sourceRefs.every(ref=>ref.type!=='classroom'||sourceKey(ref)===sourceKey(assignment))));
  if(!existing.length&&source.type==='gmail'&&!assignment&&!/\b(submit|complete|assignment|homework|deadline|due|action required|please\s+(?:review|send|finish|respond))\b/i.test(source.title+'\n'+source.text))return null;
  const base=existing[0],main=assignment??source;
  const id=base?.id??'task:'+sourceKey(main);
  const controls=this.store.get<Controls>('task-controls',id)?.data??{};
  const refs=new Map<string,SourceRef>();for(const task of existing)for(const ref of task.sourceRefs)refs.set(sourceKey(ref),ref);for(const s of related)refs.set(sourceKey(s),sourceRef(s));
  const state=existing.find(t=>t.status==='dismissed')??existing.find(t=>t.status==='complete')??base;
  const plan=existing.find(t=>t.plannedDue)?.plannedDue,override=existing.find(t=>t.override)?.override;
  const task:Task={...(base??{}),id,version:(base?.version??0)+1,title:controls.title&&base?base.title:main.title.slice(0,300),notes:controls.notes&&base?base.notes:main.text.slice(0,12000),status:state?.status??'open',kind:assignment?'classroom':source.type,officialDue:assignment?.officialDue??(source.type==='classroom'?source.officialDue??{kind:'unknown'}:extractEmailDue(source.title+'\n'+source.text)),...(plan?{plannedDue:plan}:{}),...(override?{override}:{}),sourceRefs:[...refs.values()],confidence:assignment||source.type==='classroom'?'clear':'review',createdAt:base?.createdAt??this.clock.iso(),updatedAt:this.clock.iso()};
  const saved=this.store.put('tasks',id,task,base?.version??null);
  for(const other of existing.slice(1)){const otherControls=this.store.get<Controls>('task-controls',other.id);if(otherControls){this.store.put('task-controls',id,{...controls,...otherControls.data},this.store.get('task-controls',id)?.version??null);this.store.remove('task-controls',other.id,otherControls.version)}this.store.remove('tasks',other.id,other.version)}
  return {...saved.data,version:saved.version,updatedAt:saved.updatedAt};
 })}
}

