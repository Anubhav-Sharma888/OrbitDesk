import {it,expect,beforeAll} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
let code:string;
beforeAll(()=>{execFileSync('node',['scripts/build.mjs'],{cwd:process.cwd(),stdio:'pipe'});code=readFileSync('dist/apps-script/Code.gs','utf8')});
it('deployedAppsScriptBundleDefinesTheGlobalEntrypointsAndVendorLibrary',()=>{
 // The deployed Code.gs concatenates the vendored OAuth2 library, the bundled
 // server IIFE and the four global wrappers; verify those statically because
 // behavior is exercised against the ESM twin built from the same entrypoint.
 for(const name of ['doGet','rpc','authCallback','scheduledSync'])expect(code).toContain(`function ${name}(argument) { return OrbitDeskServer.${name}(argument); }`);
 expect(code).toContain('OrbitDeskServer');
 expect(code.toLowerCase()).toContain('oauth2');
});
it('serverEntryPointsFailClosedForAnEmptyActiveIdentity',async()=>{
 // Import the ESM twin (same entrypoint as the deployed bundle) with mocked
 // Apps Script globals; the rpc guard must derive identity only from the
 // session and must never leak restricted properties.
 const secretMarker=['private','restricted','value'].join('-');
 const html=(s:string)=>({getContent:()=>s,setTitle(){return this},addMetaTag(){return this}});
 (globalThis as any).HtmlService={createHtmlOutput:html,createTemplateFromFile:()=>({evaluate(){return this},setTitle(){return this},addMetaTag(){return this}})};
 (globalThis as any).PropertiesService={getScriptProperties:()=>({getProperty:(key:string)=>key==='OWNER_EMAIL'?'owner@example.com':secretMarker})};
 (globalThis as any).Session={getActiveUser:()=>({getEmail:()=>''}),getEffectiveUser:()=>({getEmail:()=>'owner@example.com'})};
 const server=await import('../../dist/testable/server.mjs');
 for(const name of ['doGet','rpc','authCallback','scheduledSync'])expect(typeof (server as any)[name]).toBe('function');
 const result=(server as any).rpc({type:'state.get',requestId:'r1',payload:{}});
 expect(result).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});
 expect((server as any).doGet().getContent()).toContain('Owner access required');
 expect(JSON.stringify(result)).not.toContain(secretMarker);
});
