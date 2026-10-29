import {it,expect,beforeAll} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
let code:string;
beforeAll(()=>{execFileSync(process.execPath,['scripts/build.mjs'],{cwd:process.cwd(),stdio:'pipe'});code=readFileSync('dist/apps-script/Code.gs','utf8')});
it('serverEntryPointsSurviveBundlingAndFailClosedForAnEmptyActiveIdentity',()=>{
 const html=(s:string)=>({getContent:()=>s,setTitle(){return this},addMetaTag(){return this}});
 const context:any={HtmlService:{createHtmlOutput:html},PropertiesService:{getScriptProperties:()=>({getProperty:(key:string)=>key==='OWNER_EMAIL'?'owner@example.com':'PRIVATE-SECRET'})},Session:{getActiveUser:()=>({getEmail:()=>''}),getEffectiveUser:()=>({getEmail:()=>'owner@example.com'})}};
 vm.createContext(context);vm.runInContext(code,context);
 for(const name of ['doGet','rpc','authCallback','scheduledSync'])expect(typeof context[name]).toBe('function');
 const result=context.rpc({type:'state.get',requestId:'r1',payload:{}});
 expect(result).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});
 expect(context.doGet().getContent()).toContain('Owner access required');
 expect(JSON.stringify(result)).not.toContain('PRIVATE-SECRET');
});
