import {describe,it,expect} from 'vitest';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
import {GoogleTransport} from '../../src/providers/transport.js';
import {AppError} from '../../src/shared/contracts.js';

function setup() {
  let n=0;let time=1000;const exchanges:string[]=[];const resets:string[]=[];
  const identities:Record<string,{sub:string;email:string;emailVerified:boolean;scopes:string[]}>= {};
  const secrets=new MemorySecrets();
  const factory={service:(name:string)=>({
    authorizationUrl:(params:Record<string,string>)=>'https://accounts.google.com/o/oauth2/v2/auth?pending='+params.pendingId,
    exchange:()=>{exchanges.push(name);return true},
    identity:()=>identities[name]??{sub:'sub-a',email:'a@example.com',emailVerified:true,scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly']},
    accessToken:()=>'TOKEN-PRIVATE-'+name,
    reset:()=>{resets.push(name)}
  })};
  const broker=new OAuthBroker({owner:'owner@example.com',secrets,factory,clock:{now:()=>time,iso:()=>new Date(time).toISOString()},ids:{next:()=>String(++n),hash:(s:string)=>s}});
  return {broker,secrets,exchanges,resets,identities,advance:()=>{time=1_000_000}};
}
describe('account access boundaries',()=>{
 it('rejectsCallbackForWrongPendingConnection',()=>{
   const t=setup();const p=t.broker.beginConnection('owner@example.com',['mail.read'],'a@example.com');
   expect(()=>t.broker.completeConnection('owner@example.com',{pendingId:p.pendingId,serviceName:'wrong',code:'x'})).toThrowError('Connection callback does not match');
   expect(t.exchanges).toEqual([]);
 });
 it('replayedOrExpiredCallbackCannotExchange',()=>{
   const t=setup();const p=t.broker.beginConnection('owner@example.com',['mail.read']);
   t.advance();
   expect(()=>t.broker.completeConnection('owner@example.com',{pendingId:p.pendingId,serviceName:p.serviceName,code:'x'})).toThrowError('Connection request expired');
   expect(t.exchanges).toEqual([]);
   const n=t.broker.beginConnection('owner@example.com',['mail.read']);
   const c={pendingId:n.pendingId,serviceName:n.serviceName,code:'x'};
   t.broker.completeConnection('owner@example.com',c);
   expect(()=>t.broker.completeConnection('owner@example.com',c)).toThrowError('Connection request is no longer active');
   expect(t.exchanges).toEqual([n.serviceName]);
 });
 it('deniedConsentCreatesIndependentBlockedState',()=>{
   const t=setup();const a=t.broker.beginConnection('owner@example.com',['mail.read']);
   const connected=t.broker.completeConnection('owner@example.com',{pendingId:a.pendingId,serviceName:a.serviceName,code:'x'});
   const b=t.broker.beginConnection('owner@example.com',['mail.read']);
   expect(t.broker.completeConnection('owner@example.com',{pendingId:b.pendingId,serviceName:b.serviceName,error:'access_denied'}).status).toBe('blocked');
   expect(t.broker.listConnections('owner@example.com')).toHaveLength(1);
   expect(t.broker.listConnections('owner@example.com')[0].id).toBe(connected.connection!.id);
 });
 it('responseNeverContainsToken',()=>{
   const t=setup();const a=t.broker.beginConnection('owner@example.com',['mail.read']);
   const result=t.broker.completeConnection('owner@example.com',{pendingId:a.pendingId,serviceName:a.serviceName,code:'x'});
   expect(JSON.stringify(result)).not.toMatch(/TOKEN|accessToken|refreshToken|clientSecret|serviceName/);
   expect(()=>t.broker.listConnections('stranger@example.com')).toThrowError('Owner access required');
   expect(()=>t.broker.beginConnection('', ['mail.read'])).toThrowError('Owner access required');
 });
 it('actualIdentityControlsConnection',()=>{
   const t=setup();const a=t.broker.beginConnection('owner@example.com',['mail.read'],'a@example.com');
   t.identities[a.serviceName]={sub:'not-a',email:'other@example.com',emailVerified:true,scopes:['openid','email']};
   expect(()=>t.broker.completeConnection('owner@example.com',{pendingId:a.pendingId,serviceName:a.serviceName,code:'x'})).toThrowError('Selected account does not match');
   expect(t.broker.listConnections('owner@example.com')).toEqual([]);
   const b=t.broker.beginConnection('owner@example.com',['mail.read']);
   const one=t.broker.completeConnection('owner@example.com',{pendingId:b.pendingId,serviceName:b.serviceName,code:'x'});
   const c=t.broker.beginConnection('owner@example.com',['mail.read']);
   const two=t.broker.completeConnection('owner@example.com',{pendingId:c.pendingId,serviceName:c.serviceName,code:'x'});
   expect(two.connection!.id).toBe(one.connection!.id);
   expect(t.broker.listConnections('owner@example.com')).toHaveLength(1);
   expect(t.resets).toContain(b.serviceName);
 });
 it('connectionTokenCannotChooseAnotherGmailIdentityOrArbitraryHost',()=>{
   const t=setup();const a=t.broker.beginConnection('owner@example.com',['mail.read']);
   const c=t.broker.completeConnection('owner@example.com',{pendingId:a.pendingId,serviceName:a.serviceName,code:'x'}).connection!;
   const requests:any[]=[];const transport=new GoogleTransport(t.broker,{fetch:(r:any)=>{requests.push(r);return {status:200,json:{messages:[]}}}});
   expect(()=>transport.request(c.id,'gmail','https://evil.example/data','mail.read')).toThrowError('Unsupported provider path');
   expect(()=>transport.request(c.id,'gmail','/users/other@example.com/messages','mail.read')).toThrowError('Gmail requests must use the connected identity');
   expect(()=>transport.request('unknown','gmail','/users/me/profile','mail.read')).toThrowError('Connection is not available');
   const result=transport.request(c.id,'gmail','/users/me/profile','mail.read');
   expect(result).toEqual({messages:[]});
   expect(requests[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
   expect(requests[0].followRedirects).toBe(false);
   expect(requests[0].headers.Authorization).toMatch(/^Bearer TOKEN-PRIVATE-/);
 });
 it('providerErrorsDoNotExposeSecretsOrResponseBodies',()=>{
   const t=setup();const p=t.broker.beginConnection('owner@example.com',['mail.read']);
   const c=t.broker.completeConnection('owner@example.com',{pendingId:p.pendingId,serviceName:p.serviceName,code:'x'}).connection!;
   const transport=new GoogleTransport(t.broker,{fetch:()=>({status:403,json:{secret:'PRIVATE-TOKEN-EMAIL-BODY'}})});
   try {transport.request(c.id,'gmail','/users/me/profile','mail.read');throw Error('did not reject')} catch(e) {
     expect(e).toBeInstanceOf(AppError);expect((e as AppError).code).toBe('PROVIDER_FORBIDDEN');
     expect(String(e)).not.toMatch(/PRIVATE|TOKEN|EMAIL/);
   }
 });
});
