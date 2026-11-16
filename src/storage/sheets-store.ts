import {AppError,type Clock,type RecordRow,type RecordStore} from '../shared/contracts.js';
import {MemoryRecordStore} from './record-store.js';
export interface SheetPort {readRows():unknown[][];writeRows(rows:unknown[][]):void}
const header=['kind','id','version','updatedAt','payload'];
export class SheetRecordStore implements RecordStore {
 private working:MemoryRecordStore|null=null;
 private dirty=false;private previousLength=0;
 constructor(private port:SheetPort,private clock:Clock,private locker:<T>(work:()=>T)=>T){}
 get<T=unknown>(kind:string,id:string):RecordRow<T>|null{return this.atomic(()=>this.working!.get<T>(kind,id))}
 list<T=unknown>(kind:string):RecordRow<T>[]{return this.atomic(()=>this.working!.list<T>(kind))}
 put<T>(kind:string,id:string,data:T,version:number|null):RecordRow<T>{return this.atomic(()=>{const result=this.working!.put(kind,id,data,version);this.dirty=true;return result})}
 remove(kind:string,id:string,version:number):void{this.atomic(()=>{this.working!.remove(kind,id,version);this.dirty=true})}
 atomic<T>(work:()=>T):T{
  if(this.working)return work();
  return this.locker(()=>{
   const raw=this.port.readRows();this.previousLength=raw.length;this.dirty=false;
   if(raw.length&&header.some((v,i)=>raw[0]?.[i]!==v))throw new AppError('STORAGE_CORRUPT','The OrbitDesk data sheet header needs repair');
   const rows:RecordRow[]=[];
   for(const r of raw.slice(1)) {
    if(r.every(v=>v===''||v===null))continue;
    try {
     if(typeof r[0]!=='string'||typeof r[1]!=='string'||typeof r[2]!=='number'||typeof r[3]!=='string'||typeof r[4]!=='string')throw Error('shape');
     rows.push({kind:r[0],id:r[1],version:r[2],updatedAt:r[3],data:JSON.parse(r[4])});
    }catch{throw new AppError('STORAGE_CORRUPT','A stored OrbitDesk record needs repair')}
   }
   this.working=new MemoryRecordStore(this.clock,rows);
   try {
    const result=this.working.atomic(work);
    if(this.dirty) {
     const values:unknown[][]=[header,...this.working.dump().map(row=>[row.kind,row.id,row.version,row.updatedAt,JSON.stringify(row.data)])];
     while(values.length<this.previousLength)values.push(['','','','','']);
     this.port.writeRows(values);
    }
    return result;
   }finally{this.working=null;this.dirty=false}
  });
 }
}
export class AppsSheetPort implements SheetPort {
 constructor(private sheet:GoogleAppsScript.Spreadsheet.Sheet){}
 readRows():unknown[][] {const last=this.sheet.getLastRow();return last?this.sheet.getRange(1,1,last,5).getValues():[]}
 writeRows(rows:unknown[][]):void {
  if(rows.length>this.sheet.getMaxRows())this.sheet.insertRowsAfter(this.sheet.getMaxRows(),rows.length-this.sheet.getMaxRows());
  // Google Sheets applies input interpretation to values written via
  // setValues: a bare ISO date string (the sync_budgets record id, for
  // example) is stored as a numeric date serial, which the record parser
  // then rejects as corrupt. Prefixing such cells with an apostrophe forces
  // text storage; getValues returns the clean string afterwards. Only bare
  // YYYY-MM-DD strings are affected — payloads are JSON objects and other
  // ids contain non-date prefixes (observed live 2026-11-15).
  const guarded=rows.map(row=>row.map(protectSheetCell));
  this.sheet.getRange(1,1,guarded.length,5).setValues(guarded as (string|number|boolean|Date)[][]);
  SpreadsheetApp.flush();
 }
}
// Exported for tests. Models the one coercion Google Sheets performs on
// values this application writes.
export function protectSheetCell(value:unknown):unknown {
 return typeof value==='string'&&dateLike.test(value)?"'"+value:value;
}
const dateLike=/^\d{4}-\d{2}-\d{2}$/;
