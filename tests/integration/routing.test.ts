import {it,expect} from 'vitest';
import {AppError,type Task,type RoutingRule,type Destination,type RouteDecision,type RecordStore} from '../../src/shared/contracts.js';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {RoutingService,decideRoute} from '../../src/routing/rules.js';
import {CalendarReconciler,managedEventId} from '../../src/routing/reconcile.js';
import {GoogleCalendar,type CalendarPort,type CalendarEvent,type ManagedCalendarEvent,type CalendarOwnership} from '../../src/providers/google-calendar.js';
const clock={now:()=>0,iso:()=> '2026-10-29T00:00:00.000Z'};
const ids={next:()=> 'id1',hash:(v:string)=> Array.from(v).map(c=>c.charCodeAt(0).toString(16).padStart(4,'0')).join('')};
const d=(connectionId:string):Destination=>({connectionId,calendarId:connectionId+'-calendar'});
const automatic=(connectionId:string):RouteDecision=>({mode:'automatic',destinations:[d(connectionId)]});
function task(connectionId='A',change:Partial<Task>={}):Task{return {id:'task-1',version:1,title:'Assignment',notes:'Private study time',status:'open',kind:'classroom',officialDue:{kind:'date',date:'2026-11-01'},sourceRefs:[{connectionId,type:'classroom',id:'work-1',courseId:'course-1'}],confidence:'clear',createdAt:clock.iso(),updatedAt:clock.iso(),...change}}
function rule(id:string,sources:string[],to:string,change:Partial<RoutingRule>={}):RoutingRule{return {id,version:1,label:id,sourceConnectionIds:sources,priority:0,enabled:true,conditions:{},decision:automatic(to),...change}}
class CalendarFake implements CalendarPort {
 events=new Map<string,CalendarEvent>();writes:{method:string;destination:Destination;body?:ManagedCalendarEvent;etag?:string}[]=[];roles:Record<string,string>={}; failAfterInsert=false;failUpdate=false;
 listCalendars(connectionId:string){return [{connectionId,id:connectionId+'-calendar',summary:connectionId,accessRole:this.roles[connectionId]??'owner',writable:['owner','writer'].includes(this.roles[connectionId]??'owner')}];}
 key(destination:Destination,id:string){return destination.connectionId+'|'+destination.calendarId+'|'+id}
 get(destination:Destination,id:string){return structuredClone(this.events.get(this.key(destination,id))??null)}
 insert(destination:Destination,body:ManagedCalendarEvent){const key=this.key(destination,body.id);if(this.events.has(key))throw new AppError('ALREADY_EXISTS','collision');const event={...structuredClone(body),etag:'"1"'};this.events.set(key,event);this.writes.push({method:'POST',destination,body});if(this.failAfterInsert)throw new AppError('NETWORK_UNCERTAIN','timeout');return event;}
 update(destination:Destination,body:ManagedCalendarEvent,etag:string){const key=this.key(destination,body.id);if(this.failUpdate||this.events.get(key)?.etag!==etag)throw new AppError('REMOTE_CONFLICT','changed');const event={...structuredClone(body),etag:'"2"'};this.events.set(key,event);this.writes.push({method:'PATCH',destination,body,etag});return event;}
 delete(destination:Destination,id:string,etag:string,_ownership:CalendarOwnership){const key=this.key(destination,id);if(this.events.get(key)?.etag!==etag)throw new AppError('REMOTE_CONFLICT','changed');this.events.delete(key);this.writes.push({method:'DELETE',destination,etag});}
 restore(destination:Destination,body:ManagedCalendarEvent,etag:string){const key=this.key(destination,body.id);const current=this.events.get(key);if(!current||current.status!=='cancelled'||current.etag!==etag)throw new AppError('REMOTE_CONFLICT','changed');const event={...structuredClone(body),etag:'"2"'};this.events.set(key,event);this.writes.push({method:'POST',destination,body});return event;}
}
function fixture(){const store=new MemoryRecordStore(clock),calendar=new CalendarFake();return {store,calendar,reconcile:new CalendarReconciler(store,calendar,clock,ids)}}
it('routesAToDAndCDToB',()=>{
 const rules=[rule('A-D',['A'],'D'),rule('CD-B',['C','D'],'B')];
 for(const [source,destination] of [['A','D'],['C','B'],['D','B']])expect(decideRoute(task(source),{rules}).decision).toEqual(automatic(destination));
});
it('masterCalendarUsesOneDestination',()=>{
 const rules=[rule('master',['A','B','C','D'],'M')];
 for(const source of ['A','B','C','D'])expect(decideRoute(task(source),{rules}).decision.destinations).toEqual([d('M')]);
});
it('specificPriorityAndItemOverrideWin',()=>{
 const rules=[rule('broad',['A'],'D'),rule('course',['A'],'B',{priority:10,conditions:{courseId:'course-1'}})];
 expect(decideRoute(task(),{rules,accountDefaults:{A:automatic('C')}}).decision).toEqual(automatic('B'));
 expect(decideRoute(task('A',{override:automatic('M')}),{rules}).decision).toEqual(automatic('M'));
 expect(decideRoute(task('A',{importedUnreviewed:true,override:automatic('M')}),{rules}).decision.mode).toBe('review');
});
it('calendarDeniedDoesNotUseAnotherDefault',()=>{
 const {store,calendar}=fixture();calendar.roles.D='reader';const routing=new RoutingService(store,clock,ids,calendar);
 const preview=routing.preview(task(),{rules:[rule('selected',['A'],'D')],accountDefaults:{A:automatic('B')}});
 expect(preview.decision).toEqual(automatic('D'));expect(preview.errors).toHaveLength(1);
 const result=new CalendarReconciler(store,calendar,clock,ids).reconcile(task(),preview.decision);
 expect(result.status).toBe('blocked');expect(calendar.events.size).toBe(0);
});
it('routingRulesSaveWithConcurrentVersionChecks',()=>{
 const {store,calendar}=fixture();const routing=new RoutingService(store,clock,ids,calendar);
 const saved=routing.saveRule(rule('one',['A'],'D'),null);expect(saved.version).toBe(1);
 routing.saveRule({...saved,label:'Updated'},1);expect(()=>routing.saveRule({...saved,label:'Stale'},1)).toThrowError('This item changed on another device');
 expect(routing.preview(task()).decision).toEqual(automatic('D'));
});
it('repeatedReconcileCreatesOneEvent',()=>{
 const {calendar,reconcile}=fixture();expect(reconcile.reconcile(task(),automatic('D')).status).toBe('synced');
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('synced');expect(calendar.events.size).toBe(1);expect(calendar.writes.filter(w=>w.method==='POST')).toHaveLength(1);
 const event=[...calendar.events.values()][0];expect(event.id).toMatch(/^[a-v0-9]{5,1024}$/);expect(event.start).toEqual({date:'2026-11-01'});expect(event.end).toEqual({date:'2026-11-02'});
});
it('foreignCollisionIsNotAdopted',()=>{
 const {calendar,reconcile}=fixture();const id=managedEventId(task().id,d('D'),ids);
 calendar.events.set(calendar.key(d('D'),id),{id,etag:'"foreign"',summary:'Someone else',start:{date:'2026-11-01'},end:{date:'2026-11-02'}});
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('blocked');expect(calendar.writes).toHaveLength(0);
});
it('externalMoveChangesPlanNotOfficialDue',()=>{
 const {store,calendar,reconcile}=fixture();store.put('tasks','task-1',task(),null);reconcile.reconcile(task(),automatic('D'));
 const [key,event]=[...calendar.events.entries()][0];calendar.events.set(key,{...event,etag:'"moved"',start:{dateTime:'2026-10-31T10:00:00.000Z',timeZone:'UTC'},end:{dateTime:'2026-10-31T10:30:00.000Z',timeZone:'UTC'}});
 const result=reconcile.reconcile(task(),automatic('D'));expect(result.task.officialDue).toEqual({kind:'date',date:'2026-11-01'});expect(result.task.plannedDue).toEqual({kind:'instant',at:'2026-10-31T10:00:00.000Z',zone:'UTC'});
 expect(store.get<Task>('tasks','task-1')!.data.plannedDue).toEqual(result.task.plannedDue);expect(calendar.writes).toHaveLength(1);
});
it('unknownCreateUsesDurableIdAndReconcilesWithoutDuplicates',()=>{
 const {store,calendar,reconcile}=fixture();calendar.failAfterInsert=true;
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('unknown');expect(store.list<{status:string}>('calendar_operation').some(r=>r.data.status==='unknown')).toBe(true);
 calendar.failAfterInsert=false;expect(new CalendarReconciler(store,calendar,clock,ids).reconcile(task(),automatic('D')).status).toBe('synced');expect(calendar.events.size).toBe(1);expect(calendar.writes).toHaveLength(1);
});
it('duplicateInsertDoesNotRestoreAnExternallyCancelledEvent',()=>{
 const {calendar,reconcile}=fixture();
 const destination=d('D');
 const id=managedEventId(task().id,destination,ids);
 const key=calendar.key(destination,id);
 reconcile.reconcile(task(),automatic('D'));
 const cancelled={...calendar.events.get(key)!,status:'cancelled'};
 const recovery=fixture();
 recovery.calendar.events.set(key,cancelled);
 const get=recovery.calendar.get.bind(recovery.calendar);
 let firstLookup=true;
 recovery.calendar.get=(target,eventId)=>{
  if(firstLookup){firstLookup=false;return null;}
  return get(target,eventId);
 };
 expect(recovery.reconcile.reconcile(task(),automatic('D'))).toMatchObject({status:'conflict',error:expect.stringContaining('deleted elsewhere')});
 expect(recovery.calendar.events.get(key)?.status).toBe('cancelled');
 expect(recovery.calendar.writes).toHaveLength(0);
});
it('uncertainRestoreRetriesOnlyTheSameCancelledVersion',()=>{
 const {calendar,reconcile}=fixture();
 const destination=d('D');
 const id=managedEventId(task().id,destination,ids);
 const key=calendar.key(destination,id);
 const remove=calendar.delete.bind(calendar);
 calendar.delete=(target,eventId,etag,owner)=>{
  const event=calendar.get(target,eventId)!;
  remove(target,eventId,etag,owner);
  calendar.events.set(key,{...event,status:'cancelled',etag:'"cancelled"'});
 };
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('synced');
 expect(reconcile.reconcile(task('A',{status:'complete'}),automatic('D')).status).toBe('synced');
 const restore=calendar.restore.bind(calendar);
 calendar.restore=()=>{throw new AppError('NETWORK_UNCERTAIN','timeout');};
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('unknown');
 calendar.restore=restore;
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('synced');
 expect(reconcile.reconcile(task(),automatic('D')).status).toBe('synced');
 expect(calendar.writes.map(write=>write.method)).toEqual(['POST','DELETE','POST']);
});
it('calendarConflictKeepsRemoteEditAndPendingOperation',()=>{
 const {store,calendar,reconcile}=fixture();reconcile.reconcile(task(),automatic('D'));calendar.failUpdate=true;
 expect(reconcile.reconcile(task('A',{title:'Updated title'}),automatic('D')).status).toBe('conflict');expect([...calendar.events.values()][0].summary).toBe('Assignment');
 expect(store.list<{status:string}>('calendar_operation').some(r=>r.data.status==='conflict')).toBe(true);
});
it('deleteChecksOwnershipAndUsesFreshEtag',()=>{
 const {calendar,reconcile}=fixture();reconcile.reconcile(task(),automatic('D'));const [key,event]=[...calendar.events.entries()][0];
 calendar.events.set(key,{...event,extendedProperties:{private:{orbitdesk:'foreign'}},etag:'"changed"'});
 expect(reconcile.reconcile(task('A',{status:'complete'}),automatic('D')).status).toBe('blocked');expect(calendar.events.size).toBe(1);
});
it('calendarWritesNeverInviteAttendees',()=>{
 const requests:{path:string;method?:string;body?:unknown;headers?:Record<string,string>}[]=[];let current:CalendarEvent|null=null;
 const calendar=new GoogleCalendar({request:(_connection,_api,path,_cap,method='GET',body?:unknown,headers?:Record<string,string>)=>{requests.push({path,method,body,headers});if(path.startsWith('/users/me/calendarList'))return {items:[{id:'D-calendar',summary:'D',accessRole:'owner'}]};if(method==='GET'){if(!current)throw new AppError('NOT_FOUND','absent');return current}if(method==='DELETE'){current=null;return undefined}current={...(body as ManagedCalendarEvent),etag:'"provider"'};return current;}});
 const store=new MemoryRecordStore(clock);const reconciler=new CalendarReconciler(store,calendar,clock,ids);reconciler.reconcile(task(),automatic('D'));reconciler.reconcile(task('A',{title:'Changed'}),automatic('D'));reconciler.reconcile(task('A',{status:'complete'}),automatic('D'));
 const writes=requests.filter(r=>r.method!=='GET');expect(writes.map(r=>r.method)).toEqual(['POST','PATCH','DELETE']);
 for(const request of writes){expect(request.path).toContain('sendUpdates=none');expect(request.body??{}).not.toHaveProperty('attendees');expect(request.body??{}).not.toHaveProperty('conferenceData');}
 expect(writes[1].headers).toEqual({'If-Match':'"provider"'});expect(writes[2].headers).toEqual({'If-Match':'"provider"'});
});
it('calendarListPagesIncludeUnsupportedRolesVisibly',()=>{
 let calls=0;const calendar=new GoogleCalendar({request:(_c,_a,path)=>{calls++;return path.includes('pageToken=next')?{items:[{id:'b',summary:'Limited',accessRole:'freeBusyReader'}]}:{items:[{id:'a',summary:'Writable',accessRole:'writer'}],nextPageToken:'next'};}});
 const list=calendar.listCalendars('A');expect(calls).toBe(2);expect(list.map(v=>[v.id,v.writable,v.accessRole])).toEqual([['a',true,'writer'],['b',false,'freeBusyReader']]);
});


it('providerCannotReturnAnotherEventForDeterministicLookup',()=>{
 const calendar=new GoogleCalendar({request:()=>({id:'foreign000',etag:'"x"',start:{date:'2026-11-01'},end:{date:'2026-11-02'}})});
 expect(()=>calendar.get(d('D'),'od000')).toThrowError('Google returned a different calendar event');
});
it('pendingOperationIsDurableBeforeProviderMutation',()=>{
 const {store,calendar}=fixture();const original=calendar.insert.bind(calendar);let durable=false;
 calendar.insert=(destination,event)=>{const pending=store.get<{status:string;action:string}>('calendar_operation',event.id);durable=pending?.data.status==='pending'&&pending.data.action==='insert';return original(destination,event)};
 expect(new CalendarReconciler(store,calendar,clock,ids).reconcile(task(),automatic('D')).status).toBe('synced');expect(durable).toBe(true);
});
it('ownedEventWithExternalGuestsIsNeverUpdatedOrDeleted',()=>{
 const {calendar,reconcile}=fixture();reconcile.reconcile(task(),automatic('D'));const [key,event]=[...calendar.events.entries()][0];calendar.events.set(key,{...event,attendees:[{email:'guest@example.com'}]});
 expect(reconcile.reconcile(task('A',{title:'Updated'}),automatic('D')).status).toBe('blocked');expect(reconcile.reconcile(task('A',{status:'complete'}),automatic('D')).status).toBe('blocked');expect(calendar.writes).toHaveLength(1);
});
it('conflictingSourceDefaultsRequireReviewWithoutFanout',()=>{
 const merged=task('A',{sourceRefs:[...task('A').sourceRefs,...task('B').sourceRefs]});
 expect(decideRoute(merged,{accountDefaults:{A:automatic('D'),B:automatic('M')}}).decision).toEqual({mode:'review',destinations:[]});
});
it('externalDurationIsPreservedWhenTaskTitleChanges',()=>{
 const {store,calendar,reconcile}=fixture();store.put('tasks','task-1',task(),null);reconcile.reconcile(task(),automatic('D'));
 const [key,event]=[...calendar.events.entries()][0];calendar.events.set(key,{...event,etag:'"moved"',start:{dateTime:'2026-10-31T10:00:00.000Z',timeZone:'UTC'},end:{dateTime:'2026-10-31T12:00:00.000Z',timeZone:'UTC'}});
 const moved=reconcile.reconcile(task(),automatic('D')).task;const result=reconcile.reconcile({...moved,title:'Revised title'},automatic('D'));
 expect(result.status).toBe('synced');expect([...calendar.events.values()][0].end).toEqual({dateTime:'2026-10-31T12:00:00.000Z',timeZone:'UTC'});
});
