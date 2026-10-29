import {it,expect} from 'vitest';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
function setup(){
let n=0; const workflows:string[]=[];const resets:string[]=[];
const broker=new OAuthBroker({owner:'owner@example.test',secrets:new MemorySecrets(),clock:{now:()=>0,iso:()=>new Date(0).toISOString()},ids:{next:()=>String(++n),hash:s=>s},factory:{service:(name:string,_caps?:unknown,workflow?:string)=>{workflows.push(workflow??'manual');return {authorizationUrl:()=> 'https://accounts.google.com/auth',exchange:()=>true,identity:()=>({sub:'subject',email:'a@example.test',emailVerified:true,scopes:['https://www.googleapis.com/auth/gmail.readonly']}),accessToken:()=>name,reset:()=>{resets.push(name)}}}}});
const connect=(workflow:'manual'|'agent')=>{const p=broker.beginConnection('owner@example.test',['mail.read'],'a@example.test',workflow);return broker.completeConnection('owner@example.test',{pendingId:p.pendingId,serviceName:p.serviceName,code:'x'})};
return {broker,connect,workflows,resets};
}
it('manualGrantDoesNotAuthorizeBackgroundWork',()=>{const t=setup();const id=t.connect('manual').connection!.id;expect(()=>t.broker.access(id,'mail.read','agent')).toThrow();});
it('separateBackgroundGrantSurvivesManualRelinkAndDisconnectClearsBoth',()=>{const t=setup();const id=t.connect('manual').connection!.id;t.connect('agent');const agent=t.broker.access(id,'mail.read','agent');expect(agent).toContain('agent');t.connect('manual');expect(t.broker.access(id,'mail.read','agent')).toBe(agent);expect(t.broker.listConnections('owner@example.test')[0].backgroundReady).toBe(true);t.broker.disconnect('owner@example.test',id);expect(()=>t.broker.access(id,'mail.read','agent')).toThrow();expect(t.resets).toContain(agent);});
it('agentGrantRequiresExistingManualAccount',()=>{const t=setup();expect(()=>t.connect('agent')).toThrow();});
