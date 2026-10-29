import {AppError,type Clock,type RecordRow,type RecordStore} from '../shared/contracts.js';
function copy<T>(value:T):T {return JSON.parse(JSON.stringify(value)) as T}
function identifiers(kind:string,id:string):void {
 if(!/^[a-z][a-z0-9_-]{0,39}$/.test(kind)||!/^[-A-Za-z0-9_:.]{1,300}$/.test(id))throw new AppError('INVALID_RECORD','Invalid record identifier');
}
export class MemoryRecordStore implements RecordStore {
 private rows=new Map<string,RecordRow>();
 constructor(private clock:Clock,rows:RecordRow[]=[]){
  for(const row of rows){identifiers(row.kind,row.id);if(!Number.isSafeInteger(row.version)||row.version<1)throw new AppError('STORAGE_CORRUPT','Stored record version needs repair');this.rows.set(row.kind+'\0'+row.id,copy(row))}
 }
 get<T=unknown>(kind:string,id:string):RecordRow<T>|null{identifiers(kind,id);const row=this.rows.get(kind+'\0'+id);return row?copy(row) as RecordRow<T>:null}
 list<T=unknown>(kind:string):RecordRow<T>[]{return [...this.rows.values()].filter(r=>r.kind===kind).map(r=>copy(r) as RecordRow<T>)}
 put<T>(kind:string,id:string,data:T,version:number|null):RecordRow<T>{
  identifiers(kind,id);const key=kind+'\0'+id,current=this.rows.get(key);
  if((current?.version??null)!==version)throw new AppError('VERSION_CONFLICT','This item changed on another device');
  if(data===null||typeof data!=='object'||Array.isArray(data))throw new AppError('INVALID_RECORD','Record data must be an object');
  let payload:string;
  try{payload=JSON.stringify(data,(_k,v)=>{if(typeof v==='number'&&!Number.isFinite(v))throw Error('nonfinite');return v})}
  catch{throw new AppError('INVALID_RECORD','Record data must be JSON-compatible')}
  if(payload.length>45000)throw new AppError('RECORD_LIMIT','This item is too large to save');
  if(!current&&this.rows.size>=20000)throw new AppError('STORAGE_LIMIT','Archive or remove older app data before adding more');
  const row:RecordRow<T>={kind,id,version:(current?.version??0)+1,updatedAt:this.clock.iso(),data:JSON.parse(payload) as T};
  this.rows.set(key,row);return copy(row);
 }
 remove(kind:string,id:string,version:number):void{
  const row=this.get(kind,id);if(!row||row.version!==version)throw new AppError('VERSION_CONFLICT','This item changed on another device');
  this.rows.delete(kind+'\0'+id);
 }
 atomic<T>(work:()=>T):T{
  const backup=new Map([...this.rows.entries()].map(([k,v])=>[k,copy(v)]));
  try{return work()}catch(e){this.rows=backup;throw e}
 }
 dump():RecordRow[]{return [...this.rows.values()].map(copy)}
}
