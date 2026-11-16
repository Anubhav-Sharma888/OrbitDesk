// In-memory Apps Script environment fakes for production-wiring tests.
// These drive the REAL src/app/entrypoints.ts module (scheduledSync) under
// vitest by installing fakes on globalThis — no Apps Script runtime needed.
// Everything is local and offline: UrlFetchApp records requests and answers
// from a configurable handler; no real network call is possible.
import {createHash,randomUUID} from 'node:crypto';
export interface FakeHttpRequest {url:string;method:string;headers:Record<string,string>;payload?:string}
export interface FakeHttpResponse {status:number;json:unknown}
type Handler=(call:FakeHttpRequest)=>FakeHttpResponse|undefined;
export interface RecordedTokenRequest {service:string;url:string}
export function installAppScriptFakes(owner:string){
 const properties:Record<string,string>={
  OWNER_EMAIL:owner,
  GOOGLE_CLIENT_ID:'fixture-manual-client-id',
  GOOGLE_CLIENT_SECRET:['fixture','manual','client','secret'].join('-'),
  GOOGLE_AGENT_CLIENT_ID:'fixture-agent-client-id',
  GOOGLE_AGENT_CLIENT_SECRET:['fixture','agent','client','secret'].join('-')
 };
 const sheetRows:unknown[][]=[];
 const tokenRequests:RecordedTokenRequest[]=[];
 const httpCalls:FakeHttpRequest[]=[];
 let handler:Handler=()=>undefined;
 const fakeSheet={
  get rows(){return sheetRows},
  getMaxRows:()=>Math.max(sheetRows.length,1),
  getLastRow:()=>sheetRows.length,
  getRange:(row:number,col:number,rowCount:number,colCount:number)=>({
   // Model Google's read behavior for text-forced cells: a value written with
   // a leading apostrophe (the writeRows date guard) reads back WITHOUT it.
   getValues:()=>{const out:unknown[][]=[];for(let r=0;r<rowCount;r++){const src=sheetRows[row-1+r]??[];const line:unknown[]=[];for(let c=0;c<colCount;c++){const raw=src[col-1+c]??'';line.push(typeof raw==='string'&&raw.startsWith("'")?raw.slice(1):raw)}out.push(line)}return out},
   setValues:(values:unknown[][])=>{for(let r=0;r<values.length;r++){while(sheetRows.length<=row-1+r)sheetRows.push([]);sheetRows[row-1+r]=values[r].slice()}}
  }),
  insertRowsAfter:(after:number,count:number)=>{sheetRows.splice(after,0,...Array.from({length:count},()=>[]))}
 };
 const globalAny=globalThis as Record<string,unknown>;
 const previous:Record<string,unknown>={};
 const set=(name:string,value:unknown)=>{previous[name]=globalAny[name];globalAny[name]=value};
 set('PropertiesService',{getScriptProperties:()=>({
  getProperty:(key:string)=>Object.prototype.hasOwnProperty.call(properties,key)?properties[key]:null,
  setProperty:(key:string,value:string)=>{properties[key]=value},
  deleteProperty:(key:string)=>{delete properties[key]},
  getProperties:()=>({...properties})
 })});
 set('SpreadsheetApp',{openById:(id:string)=>{
  if(id!=='sheet-1')throw new Error('unknown spreadsheet '+id);
  return {getSheets:()=>[fakeSheet]};
 },flush:()=>{}});
 set('Session',{getActiveUser:()=>({getEmail:()=>owner}),getEffectiveUser:()=>({getEmail:()=>owner})});
 set('LockService',{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{},waitLock:()=>{}})});
 set('CacheService',{getScriptCache:()=>({get:()=>null,put:()=>{},remove:()=>{}})});
 set('Utilities',{
  getUuid:()=>randomUUID(),
  DigestAlgorithm:{SHA_256:'SHA_256'},
  Charset:{UTF_8:'UTF_8'},
  computeDigest:(_alg:unknown,value:string)=>createHash('sha256').update(value,'utf8').digest(),
  base64EncodeWebSafe:(value:string)=>Buffer.from(value,'utf8').toString('base64url'),
  base64DecodeWebSafe:(value:string)=>Buffer.from(value,'base64url'),
  base64Encode:(value:string)=>Buffer.from(value,'utf8').toString('base64'),
  newBlob:(bytes:Buffer)=>({getDataAsString:()=>bytes.toString('utf8')})
 });
 // Distinct token per OAuth2 service name so tests can prove WHICH grant a
 // provider request used (manual vs agent workflow).
 set('OAuth2',{createService:(name:string)=>{
  const chain={...{}};
  const service={...chain,
   setAuthorizationBaseUrl(){return service},setTokenUrl(){return service},
   setClientId(){return service},setClientSecret(){return service},setCallbackFunction(){return service},
   setScope(){return service},setParam(){return service},setPropertyStore(){return service},setCache(){return service},setLock(){return service},
   generateCodeVerifier(){return service},setCodeChallengeMethod(){return service},
   getAuthorizationUrl:(params:Record<string,string>)=>'https://accounts.google.com/o/oauth2/v2/auth?state='+encodeURIComponent(params.pendingId??''),
   handleCallback:()=>true,
   getAccessToken:()=>'token:'+name,
   getToken:()=>({scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/classroom.coursework.me.readonly'}),
   reset:()=>{}
  };
  return service;
 }});
 set('UrlFetchApp',{fetch:(url:string,options:{method?:string;headers?:Record<string,string>;payload?:string}={})=>{
  const call:FakeHttpRequest={url,method:String(options.method??'GET').toUpperCase(),headers:{...(options.headers??{})},...(options.payload!==undefined?{payload:options.payload}:{})};
  httpCalls.push(call);
  const response=handler(call);
  const body=response??{status:200,json:{}};
  return {getResponseCode:()=>body.status,getContentText:()=>JSON.stringify(body.json??{}),getAllHeaders:()=>({})};
 }});
 return {
  properties,sheetRows,httpCalls,tokenRequests,
  sheet:fakeSheet,
  onRequest:(next:Handler)=>{handler=next},
  providerRequests:()=>httpCalls,
  requestsTo:(host:string)=>httpCalls.filter(call=>call.url.includes(host)),
  restore:()=>{for(const [name,value] of Object.entries(previous)){if(value===undefined)delete globalAny[name];else globalAny[name]=value}}
 };
}
// Header row used by SheetRecordStore/AppsSheetPort.
export const SHEET_HEADER=['kind','id','version','updatedAt','payload'];
export function seedSheetRow(sheet:ReturnType<typeof installAppScriptFakes>['sheet'],kind:string,id:string,version:number,updatedAt:string,data:unknown):void{
 sheet.rows.push([kind,id,version,updatedAt,JSON.stringify(data)]);
}
