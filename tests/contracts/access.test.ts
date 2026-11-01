import {describe,it,expect} from 'vitest';
import {OAuthBroker} from '../../src/accounts/oauth.js';
import {MemorySecrets} from '../../src/accounts/secret-store.js';
import {GoogleTransport} from '../../src/providers/transport.js';
import {AppsOAuthFactory,outboundUrlAllowed} from '../../src/app/runtime.js';
import {AppError} from '../../src/shared/contracts.js';

function setup() {
  let n=0;let time=1000;const exchanges:string[]=[];const resets:string[]=[];const authParams:Record<string,string>[]=[];
  const identities:Record<string,{sub:string;email:string;emailVerified:boolean;scopes:string[]}>= {};
  const secrets=new MemorySecrets();
  const factory={service:(name:string)=>({
    authorizationUrl:(params:Record<string,string>)=>{authParams.push({...params});return 'https://accounts.google.com/o/oauth2/v2/auth?pending='+params.pendingId},
    exchange:()=>{exchanges.push(name);return true},
    identity:()=>identities[name]??{sub:'sub-a',email:'a@example.com',emailVerified:true,scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly']},
    accessToken:()=>'TOKEN-PRIVATE-'+name,
    reset:()=>{resets.push(name)}
  })};
  const broker=new OAuthBroker({owner:'owner@example.com',secrets,factory,clock:{now:()=>time,iso:()=>new Date(time).toISOString()},ids:{next:()=>String(++n),hash:(s:string)=>s}});
  return {broker,secrets,exchanges,resets,identities,authParams,advance:()=>{time=1_000_000}};
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
 it('corruptedPendingEntriesAreRemovedInsteadOfBlockingConnect',()=>{
   // LOW-4: one unparseable pending property must not throw out of beginConnection.
   const t=setup();t.secrets.set('pending:broken','{not valid json');
   const pending=t.broker.beginConnection('owner@example.com',['mail.read']);
   expect(t.secrets.get('pending:broken')).toBeNull();
   expect(t.secrets.keys('pending:')).toEqual(['pending:'+pending.pendingId]);
   expect(pending.authorizationUrl).toContain('accounts.google.com');
 });
 it('beginConnectionForwardsTheHintIntoAuthorizationParams',()=>{
   // LOW-1 (broker side): the optional hint rides in the authorization params
   // (state token) only when supplied; it never substitutes for the pending id.
   const t=setup();
   const hinted=t.broker.beginConnection('owner@example.com',['mail.read'],'a@example.com');
   expect(t.authParams[t.authParams.length-1]).toEqual({pendingId:hinted.pendingId,hint:'a@example.com'});
   const plain=t.broker.beginConnection('owner@example.com',['mail.read']);
   expect(t.authParams[t.authParams.length-1]).toEqual({pendingId:plain.pendingId});
 });
});
describe('runtime outbound and login hint guards',()=>{
 it('outboundUrlsRejectExplicitPorts',()=>{
   // INFO: every application endpoint is portless; an explicit :port is rejected.
   expect(outboundUrlAllowed('https://gmail.googleapis.com/gmail/v1/users/me/profile')).toBe(true);
   expect(outboundUrlAllowed('https://www.googleapis.com/calendar/v3/users/me/calendarList')).toBe(true);
   expect(outboundUrlAllowed('https://gmail.googleapis.com:443/gmail/v1/users/me/profile')).toBe(false);
   expect(outboundUrlAllowed('https://api.groq.com:8443/openai/v1/chat/completions')).toBe(false);
   expect(outboundUrlAllowed('https://gmail.googleapis.com.evil.test/gmail/v1/users/me/profile')).toBe(false);
   expect(outboundUrlAllowed('http://gmail.googleapis.com/gmail/v1/users/me/profile')).toBe(false);
 });
 it('authorizationUrlBindsLoginHintOnlyForPlausibleHints',()=>{
   // LOW-1 (factory side): a plausible hint becomes a login_hint query parameter;
   // absent or implausible hints never reach the authorization URL.
   // Fabricated fixture value so no credential-shaped literal exists in the repo.
   const fixtureClientSecret=['mock','client','secret'].join('-');
   // Like the vendored library, every createService() call returns a fresh
   // service instance with its own params_ store.
   const captured:Record<string,string>[]=[];
   const makeChain=()=>{
    const setParams:Record<string,string>={};
    captured.push(setParams);
    const chain:any={};
    const passthrough=()=>chain;
    Object.assign(chain,{
     setAuthorizationBaseUrl:passthrough,setTokenUrl:passthrough,setClientId:passthrough,setClientSecret:passthrough,
     setCallbackFunction:passthrough,setScope:passthrough,setPropertyStore:passthrough,setCache:passthrough,setLock:passthrough,
     setCodeChallengeMethod:passthrough,generateCodeVerifier:passthrough,
     setParam:(name:string,value:string)=>{setParams[name]=value;return chain},
     getAuthorizationUrl:()=>{
      // Mirrors vendor buildUrl_: fixed params plus setParam values; the
      // getAuthorizationUrl argument goes into the state token, not the URL.
      const query=new URLSearchParams({client_id:'mock-client',response_type:'code',redirect_uri:'https://script.google.com/user_callback',state:'mock-state',...setParams});
      return 'https://accounts.google.com/o/oauth2/v2/auth?'+query.toString()},
     handleCallback:()=>true,getAccessToken:()=>'mock-access-value',getToken:()=>({scope:'openid'}),reset:passthrough
    });
    return chain;
   };
   (globalThis as any).PropertiesService={getScriptProperties:()=>({getProperty:(key:string)=>key==='GOOGLE_CLIENT_ID'?'mock-client-id':key==='GOOGLE_CLIENT_SECRET'?fixtureClientSecret:null})};
   (globalThis as any).LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
   (globalThis as any).CacheService={getScriptCache:()=>({get:()=>null,put:()=>{},remove:()=>{}})};
   (globalThis as any).OAuth2={createService:()=>makeChain()};
   try{
    const factory=new AppsOAuthFactory();
    const withHint=factory.service('svc-hint',['mail.read']).authorizationUrl({pendingId:'p1',hint:'owner@example.com'});
    expect(withHint).toContain('login_hint=owner%40example.com');
    expect(captured[0].login_hint).toBe('owner@example.com');
    const absent=factory.service('svc-plain',['mail.read']).authorizationUrl({pendingId:'p1'});
    expect(absent).not.toContain('login_hint');
    const implausible=factory.service('svc-bad',['mail.read']).authorizationUrl({pendingId:'p1',hint:'not an email'});
    expect(implausible).not.toContain('login_hint');
    const oversized=factory.service('svc-long',['mail.read']).authorizationUrl({pendingId:'p1',hint:'a@'+'b'.repeat(250)+'.com'});
    expect(oversized).not.toContain('login_hint');
    const whitespace=factory.service('svc-space',['mail.read']).authorizationUrl({pendingId:'p1',hint:'  owner@example.com  '});
    expect(whitespace).toContain('login_hint=owner%40example.com');
   }finally{
    for(const name of ['PropertiesService','LockService','CacheService','OAuth2'])delete (globalThis as any)[name];
   }
 });
});
