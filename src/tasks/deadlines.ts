import {AppError,type Due} from '../shared/contracts.js';
function dateIsValid(s:string):boolean {if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00.000Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s&&s>='1000-01-01'}
export function validateDue(value:Due):Due {
 if(!value||typeof value!=='object')throw new AppError('INVALID_DUE','Choose a valid date or explicit time');
 if(value.kind==='unknown')return {kind:'unknown'};
 if(value.kind==='date'&&typeof value.date==='string'&&dateIsValid(value.date))return {kind:'date',date:value.date};
 if(value.kind==='instant'&&typeof value.at==='string'&&typeof value.zone==='string'&&/^[A-Za-z_+\-/]{1,80}$/.test(value.zone)){
  const m=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value.at);
  if(m&&dateIsValid(m[1])&&Number(m[2])<24&&Number(m[3])<60&&Number(m[4])<60&&(!m[9]||(Number(m[9])<=14&&Number(m[10])<60&&(Number(m[9])<14||Number(m[10])===0)))&&Number.isFinite(Date.parse(value.at)))return {kind:'instant',at:new Date(value.at).toISOString(),zone:value.zone};
 }
 throw new AppError('INVALID_DUE','Choose a valid date or explicit time');
}
export function classroomDue(date?:unknown,time?:unknown):Due {
 if(!date||typeof date!=='object')return {kind:'unknown'};
 const d=date as Record<string,unknown>;if(!['year','month','day'].every(k=>Number.isInteger(d[k])))return {kind:'unknown'};
 const day=String(d.year).padStart(4,'0')+'-'+String(d.month).padStart(2,'0')+'-'+String(d.day).padStart(2,'0');
 if(!dateIsValid(day))return {kind:'unknown'};
 if(time===undefined)return {kind:'date',date:day};
 if(!time||typeof time!=='object')return {kind:'unknown'};
 const t=time as Record<string,unknown>;const h=t.hours??0,m=t.minutes??0,s=t.seconds??0,n=t.nanos??0;
 if(![h,m,s,n].every(Number.isInteger)||Number(h)<0||Number(h)>23||Number(m)<0||Number(m)>59||Number(s)<0||Number(s)>59||Number(n)<0||Number(n)>999999999)return {kind:'unknown'};
 return {kind:'instant',at:day+'T'+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(Math.floor(Number(n)/1000000)).padStart(3,'0')+'Z',zone:'UTC'};
}
// Only explicit calendar dates in deadline language are accepted. Relative dates and local times need review.
export function extractEmailDue(text:string):Due {
 const lines=text.split(/[\r\n]/).filter(s=>/\b(due|deadline|submit|submission|by|on)\b/i.test(s));
 const candidates=lines.join('\n').match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?/g)??[];
 const unique=[...new Set(candidates)];if(unique.length!==1)return {kind:'unknown'};
 const token=unique[0];if(token.length===10&&/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\bat\s+\d|\d{4}-\d{2}-\d{2}T/i.test(lines.join(' ')))return {kind:'unknown'};
 try{return validateDue(token.length===10?{kind:'date',date:token}:{kind:'instant',at:token,zone:'UTC'})}catch{return {kind:'unknown'}}
}
