import {AppError,type Clock,type Ids,type RecordStore,type Task,type Destination,type RouteDecision,type Due,type RecordRow} from '../shared/contracts.js';
import {assertCalendarOwnership,type CalendarPort,type CalendarEvent,type CalendarTime,type ManagedCalendarEvent,type CalendarOwnership} from '../providers/google-calendar.js';
import {normalizeDecision} from './rules.js';
export interface ReconcileResult {status:'synced'|'skipped'|'blocked'|'conflict'|'unknown';task:Task;error?:string;eventIds:string[]}
export interface CalendarLink {taskId:string;destination:Destination;eventId:string;ownership:CalendarOwnership;etag:string;lastStart:CalendarTime;lastEnd:CalendarTime;summary:string;description:string}
export interface CalendarOperation {taskId:string;destination:Destination;eventId:string;ownership:CalendarOwnership;action:'insert'|'update'|'delete'|'restore';status:'pending'|'complete'|'unknown'|'blocked'|'conflict';body?:ManagedCalendarEvent;expectedEtag?:string;at:string;error?:string;deleteConfirmed?:true}
function hash(value:string,ids:Ids):string {
 const digest=ids.hash(value).toLowerCase();
 if(!/^[a-f0-9]{8,256}$/.test(digest))throw new AppError('INVALID_HASH','A stable SHA-256 compatible hash is required for managed calendar IDs');
 return digest;
}
export function managedEventId(taskId:string,destination:Destination,ids:Ids):string {return 'od'+hash(JSON.stringify([taskId,destination.connectionId,destination.calendarId]),ids)}
function ownership(taskId:string,destination:Destination,ids:Ids):CalendarOwnership {return {orbitdesk:'v1',taskId,routeKey:hash(JSON.stringify([destination.connectionId,destination.calendarId]),ids)}}
function timeKey(time:CalendarTime):string {return typeof time.date==='string'?'date:'+time.date:typeof time.dateTime==='string'&&Number.isFinite(Date.parse(time.dateTime))?'instant:'+Date.parse(time.dateTime):'invalid'}
function sameTiming(a:{start:CalendarTime;end:CalendarTime},b:{start:CalendarTime;end:CalendarTime}):boolean{return timeKey(a.start)===timeKey(b.start)&&timeKey(a.end)===timeKey(b.end)}
function sameBody(a:CalendarEvent,b:ManagedCalendarEvent):boolean{return (a.summary??'')===b.summary&&(a.description??'')===b.description&&sameTiming(a,b)}
function validDate(date:string):boolean {return /^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00.000Z'))&&new Date(date+'T00:00:00.000Z').toISOString().slice(0,10)===date}
function dueTimes(due:Due):{start:CalendarTime;end:CalendarTime}|null {
 if(due.kind==='unknown')return null;
 if(due.kind==='date'){
  if(!validDate(due.date))throw new AppError('INVALID_DUE','The calendar date needs review');
  return {start:{date:due.date},end:{date:new Date(Date.parse(due.date+'T00:00:00.000Z')+86400000).toISOString().slice(0,10)}};
 }
 if(typeof due.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(due.at)||!Number.isFinite(Date.parse(due.at))||!due.zone||!validDate(due.at.slice(0,10)))throw new AppError('INVALID_DUE','The calendar time needs review');
 return {start:{dateTime:new Date(due.at).toISOString(),timeZone:due.zone},end:{dateTime:new Date(Date.parse(due.at)+1800000).toISOString(),timeZone:due.zone}};
}
function plannedFrom(event:CalendarEvent):Due {
 if(event.start.date&&validDate(event.start.date)&&event.end.date&&validDate(event.end.date)&&event.end.date>event.start.date)return {kind:'date',date:event.start.date};
 if(event.start.dateTime&&event.end.dateTime&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(event.start.dateTime)&&Number.isFinite(Date.parse(event.start.dateTime))&&Date.parse(event.end.dateTime)>Date.parse(event.start.dateTime))return {kind:'instant',at:new Date(event.start.dateTime).toISOString(),zone:event.start.timeZone??'UTC'};
 throw new AppError('REMOTE_CONFLICT','The calendar schedule changed into an unsupported time; review it manually');
}
export class CalendarReconciler {
 constructor(private store:RecordStore,private calendar:CalendarPort,private clock:Clock,private ids:Ids){}
 reconcile(task:Task,decision:RouteDecision):ReconcileResult {
  const result:ReconcileResult={status:'skipped',task,eventIds:[]};
  if(task.importedUnreviewed)return result;
  try {
   decision=normalizeDecision(decision);
   const stored=this.store.get<Task>('tasks',task.id);
   if(stored&&stored.version!==task.version)throw new AppError('VERSION_CONFLICT','This task changed on another device');
   if(decision.mode==='review')return result;
   const active=decision.mode==='automatic'&&task.status==='open';
   const times=active?dueTimes(task.plannedDue??task.officialDue):null;
   if(active&&!times)return result;
   const destinations=active?decision.destinations:[];
   const lists=new Map<string,ReturnType<CalendarPort['listCalendars']>>();
   for(const destination of destinations){
    if(!lists.has(destination.connectionId))lists.set(destination.connectionId,this.calendar.listCalendars(destination.connectionId));
    const calendar=lists.get(destination.connectionId)!.find(c=>c.id===destination.calendarId&&c.connectionId===destination.connectionId);
    if(!calendar?.writable||!['owner','writer'].includes(calendar.accessRole))throw new AppError('CALENDAR_UNWRITABLE','The selected calendar does not grant supported write access');
   }
   const selected=new Set(destinations.map(d=>managedEventId(task.id,d,this.ids)));
   const links=this.store.list<CalendarLink>('calendar_link').filter(r=>r.data.taskId===task.id);
   const candidates=new Map(links.map(row=>[row.id,row.data]));
   // A timed-out insert may exist remotely before a link can be saved.
   for(const row of this.store.list<CalendarOperation>('calendar_operation'))if(row.data.taskId===task.id&&row.data.action==='insert'&&row.data.status!=='complete'&&!candidates.has(row.id))candidates.set(row.id,{taskId:task.id,destination:row.data.destination,eventId:row.data.eventId,ownership:row.data.ownership,etag:'',lastStart:row.data.body?.start??{},lastEnd:row.data.body?.end??{},summary:row.data.body?.summary??'',description:row.data.body?.description??''});
   for(const [id,link] of candidates)if(!selected.has(id))this.remove(link);
   for(const destination of destinations){
    const id=managedEventId(task.id,destination,this.ids);const row=this.store.get<CalendarLink>('calendar_link',id);const owner=ownership(task.id,destination,this.ids);
    const body:ManagedCalendarEvent={id,summary:result.task.title,description:result.task.notes,...times!,extendedProperties:{private:{...owner}}};
    if(row&&result.task.plannedDue&&timeKey(body.start)===timeKey(row.data.lastStart))body.end={...row.data.lastEnd};
    const existing=this.calendar.get(destination,id);
    if(existing){
     if(existing.id!==id)throw new AppError('MALFORMED_PROVIDER','Google returned a different calendar event');
     if(existing.status==='cancelled'){
      const previous=this.store.get<CalendarOperation>('calendar_operation',id)?.data;
      const ownDelete=previous?.action==='delete'&&previous.status==='complete'&&previous.deleteConfirmed===true;
      // Retry only against the same cancelled version if a restore was not confirmed.
      const retry=previous?.action==='restore'&&(previous.status==='pending'||previous.status==='unknown')&&previous.expectedEtag===existing.etag;
      if(row||(!ownDelete&&!retry))throw new AppError('REMOTE_CONFLICT','The managed calendar event was deleted elsewhere');
      assertCalendarOwnership(existing,owner);
      this.write(id,{taskId:task.id,destination,eventId:id,ownership:owner,action:'restore',status:'pending',body,expectedEtag:existing.etag,at:this.clock.iso()},()=>this.calendar.restore(destination,body,existing.etag));
      result.eventIds.push(id);
      continue;
     }
     assertCalendarOwnership(existing,owner);
     const pending=this.store.get<CalendarOperation>('calendar_operation',id)?.data;
     const ownRecoveredWrite=pending&&pending.action!=='delete'&&['pending','unknown'].includes(pending.status)&&pending.body&&sameBody(existing,pending.body);
     if(!ownRecoveredWrite&&((row&&!sameTiming(existing,{start:row.data.lastStart,end:row.data.lastEnd}))||(!row&&!sameTiming(existing,body)))){
      result.task=this.savePersonalPlan(result.task,plannedFrom(existing));this.finish(existing,destination,owner);result.eventIds.push(id);continue;
     }
     if(sameBody(existing,body)){this.finish(existing,destination,owner);result.eventIds.push(id);continue}
     if(!row||existing.etag!==row.data.etag&&((existing.summary??'')!==row.data.summary||(existing.description??'')!==row.data.description))throw new AppError('REMOTE_CONFLICT','The calendar event was edited elsewhere; review both versions');
     this.write(id,{taskId:task.id,destination,eventId:id,ownership:owner,action:'update',status:'pending',body,expectedEtag:existing.etag,at:this.clock.iso()},()=>this.calendar.update(destination,body,existing.etag));
    }else{
     if(row)throw new AppError('REMOTE_CONFLICT','The managed calendar event was removed elsewhere; restore it manually before reconciling');
     this.write(id,{taskId:task.id,destination,eventId:id,ownership:owner,action:'insert',status:'pending',body,at:this.clock.iso()},()=>{
      try{return this.calendar.insert(destination,body)}catch(e){
       if(!(e instanceof AppError)||e.code!=='ALREADY_EXISTS')throw e;
       const found=this.calendar.get(destination,id);if(!found)throw new AppError('NETWORK_UNCERTAIN','The managed event exists but Google has not returned it yet');
       if(found.status==='cancelled')throw new AppError('REMOTE_CONFLICT','The managed calendar event was deleted elsewhere');
       assertCalendarOwnership(found,owner);if(!sameBody(found,body))throw new AppError('REMOTE_CONFLICT','The existing managed calendar event differs from the pending creation');return found;
      }
     });
    }
    result.eventIds.push(id);
   }
   result.status=destinations.length||candidates.size?'synced':'skipped';
  }catch(e){result.status=e instanceof AppError&&['REMOTE_CONFLICT','VERSION_CONFLICT'].includes(e.code)?'conflict':e instanceof AppError&&['NETWORK_UNCERTAIN','PROVIDER_FAILED'].includes(e.code)?'unknown':'blocked';result.error=e instanceof AppError?e.message:'Calendar reconciliation could not be confirmed'}
  return result;
 }
 private savePersonalPlan(task:Task,plannedDue:Due):Task {
  return this.store.atomic(()=>{
   const row=this.store.get<Task>('tasks',task.id);if(row&&row.version!==task.version)throw new AppError('VERSION_CONFLICT','This task changed on another device');
   const updated={...(row?.data??task),plannedDue,updatedAt:this.clock.iso(),version:(row?.version??task.version)+1};
   if(!row)return {...task,plannedDue};
   const saved=this.store.put('tasks',task.id,updated,row.version);return {...saved.data,version:saved.version};
  });
 }
 private finish(event:CalendarEvent,destination:Destination,owner:CalendarOwnership):void {
  assertCalendarOwnership(event,owner);
  this.store.atomic(()=>{
   const current=this.store.get<CalendarLink>('calendar_link',event.id);
   this.store.put<CalendarLink>('calendar_link',event.id,{taskId:owner.taskId,destination,eventId:event.id,ownership:owner,etag:event.etag,lastStart:event.start,lastEnd:event.end,summary:event.summary??'',description:event.description??''},current?.version??null);
   const operation=this.store.get<CalendarOperation>('calendar_operation',event.id);
   // A live event supersedes any earlier deletion evidence.
   if(operation?.data.action==='delete')this.store.remove('calendar_operation',event.id,operation.version);
   else if(operation)this.store.put('calendar_operation',event.id,{...operation.data,status:'complete',at:this.clock.iso()},operation.version);
  });
 }
 private write(id:string,operation:CalendarOperation,mutate:()=>CalendarEvent):void {
  this.store.atomic(()=>{const row=this.store.get<CalendarOperation>('calendar_operation',id);this.store.put('calendar_operation',id,operation,row?.version??null)});
  try {const event=mutate();if(event.id!==id)throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the deterministic event ID');this.finish(event,operation.destination,operation.ownership)}
  catch(e){this.fail(id,e);throw e}
 }
 private fail(id:string,error:unknown):void {
  const row=this.store.get<CalendarOperation>('calendar_operation',id);if(!row)return;
  const status:CalendarOperation['status']=error instanceof AppError&&error.code==='REMOTE_CONFLICT'?'conflict':error instanceof AppError&&['NETWORK_UNCERTAIN','PROVIDER_FAILED'].includes(error.code)?'unknown':'blocked';
  this.store.put('calendar_operation',id,{...row.data,status,at:this.clock.iso(),error:error instanceof AppError?error.code:'UNCONFIRMED'},row.version);
 }
 private remove(link:CalendarLink):void {
  const destination=link.destination;const selected=this.calendar.listCalendars(destination.connectionId).find(c=>c.id===destination.calendarId);
  if(!selected?.writable||!['owner','writer'].includes(selected.accessRole))throw new AppError('CALENDAR_UNWRITABLE','The previous route calendar is unavailable or does not grant supported write access');
  const event=this.calendar.get(destination,link.eventId);
  if(!event||event.status==='cancelled')throw new AppError('REMOTE_CONFLICT','The managed calendar event was deleted elsewhere');
  assertCalendarOwnership(event,link.ownership);
  if(link.etag&&event.etag!==link.etag)throw new AppError('REMOTE_CONFLICT','The calendar event changed elsewhere; review it before removal');
  const operation:CalendarOperation={taskId:link.taskId,destination,eventId:link.eventId,ownership:link.ownership,action:'delete',status:'pending',expectedEtag:event.etag,at:this.clock.iso()};
  const pending=this.store.atomic(()=>{
   const row=this.store.get<CalendarOperation>('calendar_operation',link.eventId);
   return this.store.put('calendar_operation',link.eventId,operation,row?.version??null);
  });
  try{this.calendar.delete(destination,link.eventId,event.etag,link.ownership)}catch(e){this.fail(link.eventId,e);throw e}
  this.store.atomic(()=>{
   this.store.put('calendar_operation',link.eventId,{...operation,status:'complete',deleteConfirmed:true,at:this.clock.iso()},pending.version);
   const current=this.store.get<CalendarLink>('calendar_link',link.eventId);
   if(current)this.store.remove('calendar_link',link.eventId,current.version);
  });
 }
}

