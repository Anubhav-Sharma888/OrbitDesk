import {AppError,type Clock,type Ids,type RecordStore,type Task,type RoutingRule,type RouteDecision,type SourceItem,type Settings,type CalendarView} from '../shared/contracts.js';
import type {CalendarPort} from '../providers/google-calendar.js';
export interface RoutingContext {rules?:RoutingRule[];sources?:SourceItem[];accountDefaults?:Record<string,RouteDecision>}
export interface RoutePreview {decision:RouteDecision;reason:string;ruleId?:string;errors:string[]}
export function normalizeDecision(value:RouteDecision):RouteDecision {
 if(!value||!['automatic','review','ignore'].includes(value.mode)||!Array.isArray(value.destinations)||value.destinations.length>9)throw new AppError('INVALID_ROUTE','Choose an explicit route mode and calendar destination');
 const seen=new Set<string>();const destinations=value.destinations.map(d=>{
  if(!d||typeof d.connectionId!=='string'||!d.connectionId.trim()||d.connectionId.length>150||typeof d.calendarId!=='string'||!d.calendarId.trim()||d.calendarId.length>1024||/[\r\n\0]/.test(d.connectionId+d.calendarId))throw new AppError('INVALID_ROUTE','Choose an explicit calendar destination');
  const key=JSON.stringify([d.connectionId,d.calendarId]);if(seen.has(key))throw new AppError('INVALID_ROUTE','A calendar destination may only appear once');seen.add(key);return {connectionId:d.connectionId,calendarId:d.calendarId};
 });
 if(value.mode==='automatic'&&!destinations.length)throw new AppError('INVALID_ROUTE','An automatic route needs an explicit destination');
 if(value.mode==='ignore'&&destinations.length)throw new AppError('INVALID_ROUTE','An ignored item cannot have calendar destinations');
 return {mode:value.mode,destinations};
}
const review=(reason:string):RoutePreview=>({decision:{mode:'review',destinations:[]},reason,errors:[]});
function selected(decision:RouteDecision,reason:string,ruleId?:string):RoutePreview {
 try{return {decision:normalizeDecision(decision),reason,...(ruleId?{ruleId}:{}),errors:[]}}
 catch(e){return {...review('This route needs repair'),errors:[e instanceof AppError?e.message:'Invalid route']}}
}
function matches(task:Task,rule:RoutingRule,sources:SourceItem[]):boolean {
 if(!rule.enabled||!Number.isFinite(rule.priority)||!rule.sourceConnectionIds.length)return false;
 return task.sourceRefs.some(ref=>{
  if(!rule.sourceConnectionIds.includes(ref.connectionId))return false;
  if(rule.conditions.courseId&&ref.courseId!==rule.conditions.courseId)return false;
  const source=sources.find(s=>s.connectionId===ref.connectionId&&s.type===ref.type&&s.id===ref.id);
  if(rule.conditions.sender&&source?.sender?.toLowerCase()!==rule.conditions.sender.toLowerCase())return false;
  return !rule.conditions.keyword||(task.title+'\n'+task.notes+'\n'+(source?.text??'')).toLowerCase().includes(rule.conditions.keyword.toLowerCase());
 });
}
export function decideRoute(task:Task,context:RoutingContext={}):RoutePreview {
 if(task.importedUnreviewed)return review('Review imported data before allowing calendar actions');
 if(task.override)return selected(task.override,'Item override');
 const specificity=(r:RoutingRule)=>Object.values(r.conditions).filter(Boolean).length;
 const matching=(context.rules??[]).filter(r=>matches(task,r,context.sources??[])).sort((a,b)=>b.priority-a.priority||specificity(b)-specificity(a)||a.sourceConnectionIds.length-b.sourceConnectionIds.length||a.id.localeCompare(b.id));
 if(matching[0])return selected(matching[0].decision,'Matching rule',matching[0].id);
 const connections=[...new Set(task.sourceRefs.map(ref=>ref.connectionId))];
 if(!connections.length)return review('Choose a route for this item');
 const defaults=connections.map(connection=>context.accountDefaults?.[connection]);
 if(defaults.some(d=>!d))return review('No account default is configured');
 const normalized=defaults.map(d=>selected(d!,'Account default'));
 if(normalized.some(p=>p.errors.length))return normalized.find(p=>p.errors.length)!;
 if(normalized.some(p=>JSON.stringify(p.decision)!==JSON.stringify(normalized[0].decision)))return review('Source accounts have different defaults; choose an item route');
 return normalized[0];
}
export class RoutingService {
 constructor(private store:RecordStore,private clock:Clock,private ids:Ids,private calendars?:Pick<CalendarPort,'listCalendars'>){}
 preview(task:Task,context:RoutingContext={}):RoutePreview {
  const settings=this.store.get<Settings>('settings','owner')?.data;
  const result=decideRoute(task,{rules:context.rules??this.store.list<RoutingRule>('routes').map(r=>({...r.data,version:r.version})),sources:context.sources??this.store.list<SourceItem>('sources').map(r=>r.data),accountDefaults:context.accountDefaults??settings?.accountDefaults??{}});
  if(result.decision.mode!=='automatic')return result;
  const cache=new Map<string,CalendarView[]>();
  for(const destination of result.decision.destinations)try{
   if(!cache.has(destination.connectionId))cache.set(destination.connectionId,this.calendars?this.calendars.listCalendars(destination.connectionId):this.store.list<CalendarView>('calendars').map(r=>r.data).filter(c=>c.connectionId===destination.connectionId));
   const calendar=cache.get(destination.connectionId)!.find(c=>c.id===destination.calendarId&&c.connectionId===destination.connectionId);
   if(!calendar||!calendar.writable||!['owner','writer'].includes(calendar.accessRole))result.errors.push('The selected calendar is unavailable or does not grant supported write access');
  }catch(e){result.errors.push(e instanceof AppError?e.message:'Calendar access could not be verified')}
  return result;
 }
 saveRule(rule:RoutingRule,expectedVersion:number|null):RoutingRule {
  if(!rule||typeof rule.label!=='string'||!rule.label.trim()||rule.label.length>200||!Array.isArray(rule.sourceConnectionIds)||!rule.sourceConnectionIds.length||rule.sourceConnectionIds.some(s=>typeof s!=='string'||!s.trim()||s.length>150)||!Number.isSafeInteger(rule.priority)||Math.abs(rule.priority)>100000||typeof rule.enabled!=='boolean'||!rule.conditions||Object.keys(rule.conditions).some(k=>!['sender','courseId','keyword'].includes(k))||Object.values(rule.conditions).some(v=>typeof v!=='string'||!v.trim()||v.length>500))throw new AppError('INVALID_ROUTE','Provide a valid routing rule with explicit sources');
  const id=rule.id||this.ids.next();const decision=normalizeDecision(rule.decision);
  return this.store.atomic(()=>{
   const saved=this.store.put('routes',id,{...rule,id,sourceConnectionIds:[...new Set(rule.sourceConnectionIds)],decision,version:(expectedVersion??0)+1},expectedVersion);
   return {...saved.data,version:saved.version};
  });
 }
 removeRule(id:string,version:number):void{this.store.remove('routes',id,version)}
}
