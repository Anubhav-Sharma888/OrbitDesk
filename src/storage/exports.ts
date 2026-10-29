import {z} from 'zod';
import {AppError,type RecordStore,type Clock,type Ids} from '../shared/contracts.js';
const text=z.string().max(16000),id=z.string().min(1).max(500),stamp=z.string().datetime();
const due=z.discriminatedUnion('kind',[z.object({kind:z.literal('unknown')}).strict(),z.object({kind:z.literal('date'),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),z.object({kind:z.literal('instant'),at:stamp,zone:z.string().max(100)}).strict()]);
const destination=z.object({connectionId:id,calendarId:id}).strict();
const decision=z.object({mode:z.enum(['automatic','review','ignore']),destinations:z.array(destination).max(9)}).strict();
const base={id,version:z.number().int().positive(),createdAt:stamp,updatedAt:stamp};
const schemas:Record<string,z.ZodType>={
tasks:z.object({...base,title:z.string().min(1).max(500),notes:text,status:z.enum(['open','complete','dismissed']),kind:z.enum(['manual','gmail','classroom']),officialDue:due,plannedDue:due.optional(),sourceRefs:z.array(z.object({connectionId:id,type:z.enum(['gmail','classroom']),id,courseId:id.optional(),courseworkId:id.optional(),url:z.string().max(2000).optional()}).strict()).max(50),confidence:z.enum(['clear','review']),override:decision.optional(),importedUnreviewed:z.boolean().optional()}).strict(),
conversations:z.object({...base,title:z.string().min(1).max(200)}).strict(),
messages:z.object({id,version:z.number().int().positive(),conversationId:id,role:z.enum(['user','assistant']),text,createdAt:stamp,sequence:z.number().int().nonnegative().optional()}).strict(),
drafts:z.object({...base,connectionId:id,sourceId:id,threadId:id,messageId:z.string().max(1000),references:z.string().max(8000),subject:z.string().max(1000),to:z.array(z.string().email().max(254)).min(1).max(10),body:text,userContent:text,status:z.enum(['draft','authorized','pending','sent','unknown','failed']),rephrased:z.boolean(),importedUnreviewed:z.boolean().optional()}).strict(),
routes:z.object({id,version:z.number().int().positive(),label:z.string().min(1).max(200),sourceConnectionIds:z.array(id).max(9),priority:z.number().int().min(-10000).max(10000),enabled:z.boolean(),conditions:z.object({sender:z.string().max(500).optional(),courseId:id.optional(),keyword:z.string().max(500).optional()}).strict(),decision}).strict()
};
const bundleSchema=z.object({format:z.literal('orbitdesk'),version:z.literal(1),exportedAt:stamp,records:z.array(z.object({kind:z.enum(['tasks','conversations','messages','drafts','routes']),id,data:z.unknown()}).strict()).max(1000)}).strict();
export class ExportService{
constructor(private store:RecordStore,private clock:Clock,private ids:Ids){}
create(){const records=Object.keys(schemas).flatMap(kind=>this.store.list<any>(kind).map(row=>({kind:kind as keyof typeof schemas,id:row.id,data:{...row.data,version:row.version}})));if(records.length>1000)throw new AppError('EXPORT_LIMIT','Export supports up to 1000 records per bundle');return {format:'orbitdesk' as const,version:1 as const,exportedAt:this.clock.iso(),records};}
preview(input:unknown):{previewId:string;count:number;expiresAt:string;effects:string[]}{
if(JSON.stringify(input).length>2_000_000)throw new AppError('IMPORT_LIMIT','Import file is too large');
const parsed=bundleSchema.safeParse(input);if(!parsed.success)throw new AppError('INVALID_IMPORT','This is not a supported OrbitDesk export');
const seen=new Set<string>();
const records=parsed.data.records.map(r=>{const result=schemas[r.kind].safeParse(r.data);if(!result.success||!(result.data as any)|| (result.data as any).id!==r.id)throw new AppError('INVALID_IMPORT','A record has unsupported fields or values');const key=r.kind+':'+r.id;if(seen.has(key))throw new AppError('INVALID_IMPORT','The import contains duplicate record IDs');seen.add(key);return {...r,data:result.data as Record<string,unknown>,expected:this.store.get(r.kind,r.id)?.version??null}});
return this.store.atomic(()=>{const previewId=this.ids.next();for(const [index,row]of records.entries())this.store.put('import_rows',previewId+':'+index,row,null);this.store.put('import_previews',previewId,{count:records.length,expires:this.clock.now()+900000},null);return {previewId,count:records.length,expiresAt:new Date(this.clock.now()+900000).toISOString(),effects:['No remote actions','Imported tasks and drafts require review','Routing rules and automation paused']};});
}
apply(previewId:string):{count:number}{
return this.store.atomic(()=>{const preview=this.store.get<{count:number;expires:number}>('import_previews',previewId);if(!preview||preview.data.expires<this.clock.now())throw new AppError('STALE_PREVIEW','Preview expired; review the import again');
for(let i=0;i<preview.data.count;i++){const item=this.store.get<any>('import_rows',previewId+':'+i);if(!item)throw new AppError('INVALID_IMPORT','Import preview is incomplete');const r=item.data;const data={...r.data};if(r.kind==='tasks'||r.kind==='drafts')data.importedUnreviewed=true;if(r.kind==='drafts')data.status='draft';if(r.kind==='routes')data.enabled=false;this.store.put(r.kind,r.id,data,r.expected);this.store.remove('import_rows',item.id,item.version);}
const settings=this.store.get<any>('settings','owner');this.store.put('settings','owner',{timeZone:'Asia/Kolkata',retentionDays:90,accountDefaults:{},...settings?.data,automationEnabled:false,aiEnabled:false,aiConsent:false},settings?.version??null);this.store.remove('import_previews',previewId,preview.version);return{count:preview.data.count};});
}
}
