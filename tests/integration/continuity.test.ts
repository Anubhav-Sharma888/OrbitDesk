import {it,expect} from 'vitest';
import {MemoryRecordStore} from '../../src/storage/record-store.js';
import {SheetRecordStore} from '../../src/storage/sheets-store.js';
import {ConversationService} from '../../src/conversations/conversations.js';
import {DraftService} from '../../src/conversations/drafts.js';
const clock={now:()=>0,iso:()=> '2026-10-29T00:00:00.000Z'};
function ids(){let n=0;return {next:()=> 'id'+(++n),hash:(v:string)=>v}}
function fixture(){const store=new MemoryRecordStore(clock);const a=new ConversationService(store,clock,ids());const b=new ConversationService(store,clock,ids());return {store,a,b}}
it('savedMessageIsVisibleFromSecondClient',()=>{
 const {a,b}=fixture();const c=a.create('My coursework');const first=a.append(c.id,'request-1','user','Plan my assignment');
 b.append(c.id,'request-2','assistant','Choose a study time.');
 expect(b.load(c.id).messages.map(m=>m.text)).toEqual(['Plan my assignment','Choose a study time.']);
 expect(b.load(c.id).messages[0].id).toBe(first.id);
});
it('sameRequestIdDoesNotAppendTwice',()=>{
 const {a,b}=fixture();const c=a.create('Coursework');const one=a.append(c.id,'request-1','user','Same message');
 expect(b.append(c.id,'request-1','user','Same message').id).toBe(one.id);
 expect(a.load(c.id).messages).toHaveLength(1);
 expect(()=>b.append(c.id,'request-1','user','Changed message')).toThrowError('This request was already used for a different operation');
});
it('staleDraftVersionIsRejected',()=>{
 const {store}=fixture();const drafts=new DraftService(store,clock,ids());
 const d=drafts.create({connectionId:'a',id:'m1',type:'gmail',title:'Assignment',text:'Due 1 November',receivedAt:clock.iso(),updatedAt:clock.iso(),sender:'Lecturer <teacher@example.com>',threadId:'t1',rfcMessageId:'<original@example.com>'},'I will submit tomorrow.');
 const saved=drafts.save(d.id,d.version,{body:'I will submit tomorrow.',userContent:'I will submit tomorrow.',to:['teacher@example.com']});
 expect(()=>drafts.save(d.id,d.version,{body:'A stale edit',userContent:'A stale edit',to:['teacher@example.com']})).toThrowError('This item changed on another device');
 expect(drafts.get(d.id).body).toBe('I will submit tomorrow.');
 expect(saved.version).toBe(2);
});
it('formulaLikeTextRemainsLiteral',()=>{
 let rows:unknown[][]=[];
 const port={readRows:()=>rows,writeRows:(r:unknown[][])=>{rows=structuredClone(r)}};
 const store=new SheetRecordStore(port,clock,work=>work());
 const conversations=new ConversationService(store,clock,ids());
 const c=conversations.create('=IMPORTXML("https://invalid.example")');
 conversations.append(c.id,'r1','user','+SUM(1,2)');
 const reloaded=new ConversationService(new SheetRecordStore(port,clock,work=>work()),clock,ids());
 expect(reloaded.load(c.id).messages[0].text).toBe('+SUM(1,2)');
 expect(reloaded.load(c.id).conversation.title).toBe('=IMPORTXML("https://invalid.example")');
 const payloads=rows.slice(1).map(r=>String(r[4]));
 expect(payloads.every(v=>v.startsWith('{'))).toBe(true);
});
it('recordValuesAreIsolatedAndFailedAtomicWorkIsRolledBack',()=>{
 const store=new MemoryRecordStore(clock);store.put('tasks','a',{notes:'original'},null);
 const v=store.get<{notes:string}>('tasks','a')!;v.data.notes='uncommitted';
 expect(store.get<{notes:string}>('tasks','a')!.data.notes).toBe('original');
 expect(()=>store.atomic(()=>{store.put('tasks','b',{notes:'temporary'},null);throw Error('abort')})).toThrow('abort');
 expect(store.get('tasks','b')).toBeNull();
});
it('sheetWritesUseFreshVersionsAcrossStoreInstances',()=>{
 let rows:unknown[][]=[];const port={readRows:()=>rows,writeRows:(r:unknown[][])=>{rows=structuredClone(r)}};
 const a=new SheetRecordStore(port,clock,work=>work()),b=new SheetRecordStore(port,clock,work=>work());
 const created=a.put('settings','owner',{timeZone:'Asia/Kolkata'},null);
 b.put('settings','owner',{timeZone:'Europe/London'},created.version);
 expect(()=>a.put('settings','owner',{timeZone:'Asia/Kolkata'},created.version)).toThrowError('This item changed on another device');
 expect(a.get<{timeZone:string}>('settings','owner')!.data.timeZone).toBe('Europe/London');
});
