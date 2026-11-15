import {AppError,type Destination,type CalendarView} from '../shared/contracts.js';
import type {GoogleTransport} from './transport.js';
export interface CalendarTime {date?:string;dateTime?:string;timeZone?:string}
export interface CalendarOwnership {orbitdesk:'v1';taskId:string;routeKey:string}
export interface CalendarEvent {id:string;etag:string;summary?:string;description?:string;start:CalendarTime;end:CalendarTime;status?:string;extendedProperties?:{private?:Record<string,string>};attendees?:unknown[];conferenceData?:unknown;recurrence?:unknown[];recurringEventId?:string}
export interface ManagedCalendarEvent extends Omit<CalendarEvent,'etag'> {summary:string;description:string;extendedProperties:{private:CalendarOwnership & Record<string,string>}}
export interface CalendarPort {listCalendars(connectionId:string):CalendarView[];get(destination:Destination,eventId:string):CalendarEvent|null;insert(destination:Destination,event:ManagedCalendarEvent):CalendarEvent;update(destination:Destination,event:ManagedCalendarEvent,etag:string):CalendarEvent;delete(destination:Destination,eventId:string,etag:string,ownership:CalendarOwnership):void;restore(destination:Destination,event:ManagedCalendarEvent,etag:string):CalendarEvent}
function record(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('MALFORMED_PROVIDER','Google returned invalid calendar data');return value as Record<string,unknown>}
export function assertCalendarOwnership(event:CalendarEvent,ownership:CalendarOwnership):void {
 const actual=event.extendedProperties?.private;
 if(!actual||actual.orbitdesk!=='v1'||actual.taskId!==ownership.taskId||actual.routeKey!==ownership.routeKey)throw new AppError('FOREIGN_EVENT','A calendar event with this ID does not have verified OrbitDesk ownership');
 if((event.attendees?.length??0)>0||event.conferenceData!=null||event.recurrence?.length||event.recurringEventId)throw new AppError('UNSUPPORTED_EVENT','This calendar event has guests, conferencing or recurrence and needs manual review');
 if(!event.etag||/[\r\n]/.test(event.etag))throw new AppError('MALFORMED_PROVIDER','Google did not supply an event version');
}
function parseEvent(value:unknown):CalendarEvent {
 const item=record(value);
 if(typeof item.id!=='string'||typeof item.etag!=='string')throw new AppError('MALFORMED_PROVIDER','Google returned an invalid calendar event');
 if(item.status==='cancelled')return {id:item.id,etag:item.etag,status:'cancelled',start:{},end:{},...(item.extendedProperties?{extendedProperties:item.extendedProperties as CalendarEvent['extendedProperties']}:{}),...(Array.isArray(item.attendees)?{attendees:item.attendees}:{}),...(item.conferenceData!=null?{conferenceData:item.conferenceData}:{}),...(Array.isArray(item.recurrence)?{recurrence:item.recurrence}:{}),...(typeof item.recurringEventId==='string'?{recurringEventId:item.recurringEventId}:{})};
 const start=record(item.start),end=record(item.end);
 return {id:item.id,etag:item.etag,start:start as CalendarTime,end:end as CalendarTime,...(typeof item.summary==='string'?{summary:item.summary}:{}),...(typeof item.description==='string'?{description:item.description}:{}),...(item.extendedProperties?{extendedProperties:item.extendedProperties as CalendarEvent['extendedProperties']}:{}),...(Array.isArray(item.attendees)?{attendees:item.attendees}:{}),...(item.conferenceData!=null?{conferenceData:item.conferenceData}:{}),...(Array.isArray(item.recurrence)?{recurrence:item.recurrence}:{}),...(typeof item.recurringEventId==='string'?{recurringEventId:item.recurringEventId}:{})};
}
function eventPath(destination:Destination,eventId?:string):string {
 if(!destination.connectionId||!destination.calendarId||/[\r\n\0]/.test(destination.connectionId+destination.calendarId))throw new AppError('INVALID_ROUTE','Choose an explicit calendar destination');
 if(eventId&&!/^[a-v0-9]{5,1024}$/.test(eventId))throw new AppError('INVALID_EVENT','Unsupported managed event ID');
 return '/calendars/'+encodeURIComponent(destination.calendarId)+'/events'+(eventId?'/'+eventId:'');
}
function payload(event:ManagedCalendarEvent):ManagedCalendarEvent {
 const ownership=event.extendedProperties?.private;
 if(!ownership||ownership.orbitdesk!=='v1'||!ownership.taskId||!ownership.routeKey)throw new AppError('INVALID_EVENT','Managed event ownership is required');
 if(event.attendees?.length||event.conferenceData!=null||event.recurrence?.length||event.recurringEventId)throw new AppError('UNSUPPORTED_EVENT','Calendar writes cannot add guests, conferencing or recurrence');
 // Whitelist every writable field. Source content never becomes provider options.
 return {id:event.id,summary:event.summary,description:event.description,start:{...event.start},end:{...event.end},extendedProperties:{private:{orbitdesk:'v1',taskId:ownership.taskId,routeKey:ownership.routeKey}}};
}
export class GoogleCalendar implements CalendarPort {
 constructor(private transport:Pick<GoogleTransport,'request'>){}
 listCalendars(connectionId:string):CalendarView[] {
  const result:CalendarView[]=[];const seen=new Set<string>();let pageToken:string|undefined;
  for(let page=0;page<20;page++){
   const query='?maxResults=250&showHidden=true'+(pageToken?'&pageToken='+encodeURIComponent(pageToken):'');
   const data=record(this.transport.request(connectionId,'calendar','/users/me/calendarList'+query,'calendar.list'));
   if(data.items!==undefined&&!Array.isArray(data.items))throw new AppError('MALFORMED_PROVIDER','Google returned an invalid calendar list');
   for(const value of data.items as unknown[]??[]){const item=record(value);if(typeof item.id!=='string'||typeof item.accessRole!=='string')throw new AppError('MALFORMED_PROVIDER','Google returned an invalid calendar');if(item.deleted===true||seen.has(item.id))continue;seen.add(item.id);result.push({connectionId,id:item.id,summary:typeof item.summary==='string'?item.summary:item.id,accessRole:item.accessRole,writable:['owner','writer'].includes(item.accessRole)});}
   if(data.nextPageToken===undefined)return result;
   if(typeof data.nextPageToken!=='string'||!data.nextPageToken||data.nextPageToken===pageToken)throw new AppError('MALFORMED_PROVIDER','Google returned an invalid calendar checkpoint');
   pageToken=data.nextPageToken;
  }
  throw new AppError('CALENDAR_LIST_LIMIT','Calendar access verification exceeded its bounded page limit');
 }
 get(destination:Destination,eventId:string):CalendarEvent|null {
  try{const event=parseEvent(this.transport.request(destination.connectionId,'calendar',eventPath(destination,eventId),'calendar.write'));if(event.id!==eventId)throw new AppError('MALFORMED_PROVIDER','Google returned a different calendar event');return event}
  catch(e){if(e instanceof AppError&&e.code==='NOT_FOUND')return null;throw e}
 }
 private writable(destination:Destination):void {
  const calendar=this.listCalendars(destination.connectionId).find(c=>c.id===destination.calendarId);
  if(!calendar?.writable||!['owner','writer'].includes(calendar.accessRole))throw new AppError('CALENDAR_UNWRITABLE','The selected calendar does not grant supported write access');
 }
 insert(destination:Destination,event:ManagedCalendarEvent):CalendarEvent {
  this.writable(destination);const body=payload(event);
  const result=parseEvent(this.transport.request(destination.connectionId,'calendar',eventPath(destination)+'?sendUpdates=none','calendar.write','POST',body));
  if(result.id!==event.id)throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the requested managed event ID');
  assertCalendarOwnership(result,body.extendedProperties.private);return result;
 }
 update(destination:Destination,event:ManagedCalendarEvent,etag:string):CalendarEvent {
  this.writable(destination);const body=payload(event);const existing=this.get(destination,event.id);
  if(!existing)throw new AppError('REMOTE_CONFLICT','The managed calendar event was removed elsewhere');
  assertCalendarOwnership(existing,body.extendedProperties.private);
  if(existing.etag!==etag)throw new AppError('REMOTE_CONFLICT','The managed calendar event changed elsewhere');
  const result=parseEvent(this.transport.request(destination.connectionId,'calendar',eventPath(destination,event.id)+'?sendUpdates=none','calendar.write','PATCH',body,{'If-Match':etag}));
  if(result.id!==event.id)throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the requested event');
  assertCalendarOwnership(result,body.extendedProperties.private);return result;
 }
 // Restore a trashed (status cancelled) OrbitDesk-owned event to active with
 // the given content. Per the Calendar API reference, cancelled events on the
 // organizer's calendar expose their details so they can be restored
 // (undeleted); events.update replaces the whole resource, so the restore
 // request carries status 'confirmed' explicitly.
 restore(destination:Destination,event:ManagedCalendarEvent,etag:string):CalendarEvent {
  this.writable(destination);const body=payload(event);const existing=this.get(destination,event.id);
  if(!existing)throw new AppError('REMOTE_CONFLICT','The managed calendar event was removed elsewhere');
  assertCalendarOwnership(existing,body.extendedProperties.private);
  if(existing.status!=='cancelled')throw new AppError('REMOTE_CONFLICT','The managed calendar event is no longer cancelled');
  if(existing.etag!==etag)throw new AppError('REMOTE_CONFLICT','The managed calendar event changed elsewhere');
  const result=parseEvent(this.transport.request(destination.connectionId,'calendar',eventPath(destination,event.id)+'?sendUpdates=none','calendar.write','PATCH',{...body,status:'confirmed'},{'If-Match':etag}));
  if(result.id!==event.id)throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the restored event');
  if(result.status==='cancelled')throw new AppError('NETWORK_UNCERTAIN','Google did not confirm the event restoration');
  assertCalendarOwnership(result,body.extendedProperties.private);return result;
 }
 delete(destination:Destination,eventId:string,etag:string,ownership:CalendarOwnership):void {
  this.writable(destination);const existing=this.get(destination,eventId);
  // A delete may only be recorded as confirmed when it removes a live,
  // ownership-verified event. An already-cancelled event was deleted
  // elsewhere (by the user) and a missing event proves nothing — both must
  // surface so no restore is ever authorized on their strength.
  if(!existing)throw new AppError('REMOTE_CONFLICT','The managed calendar event was not found on the calendar');
  assertCalendarOwnership(existing,ownership);
  if(existing.status==='cancelled')throw new AppError('REMOTE_CONFLICT','The managed calendar event was already deleted elsewhere');
  if(existing.etag!==etag)throw new AppError('REMOTE_CONFLICT','The managed calendar event changed elsewhere');
  this.transport.request(destination.connectionId,'calendar',eventPath(destination,eventId)+'?sendUpdates=none','calendar.write','DELETE',undefined,{'If-Match':etag});
 }
}

