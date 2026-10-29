export type Capability = 'mail.read'|'mail.send'|'calendar.list'|'calendar.read'|'calendar.write'|'classroom.read';
export type Due = {kind:'unknown'}|{kind:'date';date:string}|{kind:'instant';at:string;zone:string};
export type Destination = {connectionId:string;calendarId:string};
export type RouteDecision = {mode:'automatic'|'review'|'ignore';destinations:Destination[]};
export interface SourceRef {connectionId:string;type:'gmail'|'classroom';id:string;courseId?:string;courseworkId?:string;url?:string}
export interface Task {id:string;version:number;title:string;notes:string;status:'open'|'complete'|'dismissed';kind:'manual'|'gmail'|'classroom';officialDue:Due;plannedDue?:Due;sourceRefs:SourceRef[];confidence:'clear'|'review';override?:RouteDecision;importedUnreviewed?:boolean;createdAt:string;updatedAt:string}
export interface Conversation {id:string;title:string;version:number;createdAt:string;updatedAt:string}
export interface ChatMessage {id:string;conversationId:string;role:'user'|'assistant';text:string;version:number;createdAt:string}
export interface ReplyDraft {id:string;version:number;connectionId:string;sourceId:string;threadId:string;messageId:string;references:string;subject:string;to:string[];body:string;userContent:string;status:'draft'|'authorized'|'pending'|'sent'|'unknown'|'failed';rephrased:boolean;importedUnreviewed?:boolean;createdAt:string;updatedAt:string}
export interface RoutingRule {id:string;version:number;label:string;sourceConnectionIds:string[];priority:number;enabled:boolean;conditions:{sender?:string;courseId?:string;keyword?:string};decision:RouteDecision}
export interface ConnectionView {id:string;email:string;label:string;status:'active'|'reconnect'|'blocked'|'disconnected';capabilities:Capability[];paused:boolean;backgroundReady?:boolean;backgroundCapabilities?:Capability[];lastSync?:string;error?:string}
export interface CalendarView {connectionId:string;id:string;summary:string;accessRole:string;writable:boolean}
export interface SourceItem {connectionId:string;id:string;type:'gmail'|'classroom';title:string;text:string;receivedAt:string;updatedAt:string;url?:string;sender?:string;threadId?:string;rfcMessageId?:string;references?:string;courseId?:string;courseworkId?:string;officialDue?:Due;submissionState?:string}
export interface Activity {id:string;at:string;kind:string;message:string;status:'success'|'pending'|'blocked'|'unknown'|'error'}
export interface Settings {timeZone:string;automationEnabled:boolean;aiEnabled:boolean;aiConsent:boolean;accountDefaults:Record<string,RouteDecision>;retentionDays:number}
export interface UiState {app:{mode:'demo'|'live';owner:string;storageReady:boolean;aiConfigured:boolean;setupRequired:string[]};settings:Settings;accounts:ConnectionView[];calendars:CalendarView[];tasks:Task[];conversations:Conversation[];messages:ChatMessage[];drafts:ReplyDraft[];routes:RoutingRule[];activity:Activity[];sources:SourceItem[]}
export interface Command {type:string;requestId:string;payload:Record<string,unknown>}
export type RpcResponse = {ok:true;state:UiState;value?:unknown}|{ok:false;error:{code:string;message:string};state?:UiState};
export interface RecordRow<T=unknown> {kind:string;id:string;version:number;updatedAt:string;data:T}
export interface RecordStore {get<T=unknown>(kind:string,id:string):RecordRow<T>|null;list<T=unknown>(kind:string):RecordRow<T>[];put<T>(kind:string,id:string,data:T,expectedVersion:number|null):RecordRow<T>;remove(kind:string,id:string,expectedVersion:number):void;atomic<T>(work:()=>T):T}
export interface Clock {now():number;iso():string}
export interface Ids {next():string;hash(value:string):string}
export interface SecretStore {get(key:string):string|null;set(key:string,value:string):void;remove(key:string):void;keys(prefix:string):string[];atomic<T>(work:()=>T):T}
export interface HttpRequest {url:string;method:'GET'|'POST'|'PATCH'|'DELETE';headers:Record<string,string>;body?:string;followRedirects:false}
export interface HttpResponse {status:number;json:unknown;headers?:Record<string,string>}
export interface HttpPort {fetch(request:HttpRequest):HttpResponse}
export interface Codec {encodeBase64Url(value:string):string;decodeBase64Url(value:string):string;encodeBase64(value:string):string}
export class AppError extends Error {constructor(public code:string,message:string,public retryAfterSeconds?:number){super(message);this.name='AppError'}}
