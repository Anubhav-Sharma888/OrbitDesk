// OrbitDesk local demo server (also used by `npm run preview`).
//
// What it serves:
// - The real UI bundle: GET /client.js (esbuild bundles src/ui/main.ts on the
//   fly), /styles.css (src/ui/styles.css) and / (src/ui/index.html).
// - POST /api/rpc: the SAME domain/RPC contract as the deployed Apps Script
//   entrypoint, dispatched through src/app/demo-backend.ts — the real
//   AppService and domain modules with SIMULATED external providers and
//   clearly labeled sample data. AppService answers its own AppError
//   failures as {ok:false,...} JSON with HTTP 200; HTTP 400 is a malformed
//   request body; HTTP 500 is reserved for truly unexpected server errors.
// - POST /api/demo/reset: recreates the sample workspace ONLY when this
//   process was started with ORBITDESK_DEMO_ALLOW_RESET=1; without the flag
//   the endpoint answers 404, keeping test/reset hooks out of anything that
//   resembles a deployment surface (docs/spec.md). The server always binds
//   127.0.0.1 only, so the flag can never expose a reset on a LAN address.
// - POST /__test/reset and POST /__test/state: browser-acceptance hooks for
//   the real-backend test mode (tests/browser/acceptance.spec.ts DemoRpc with
//   ORBITDESK_BASE_URL set). /__test/reset takes a full UiState body and
//   rebuilds the demo backend from it (same kind/key scheme as the seeder,
//   row versions taken from the posted records); /__test/state takes a
//   Partial<UiState> patch and applies it to the CURRENT shared store (array
//   sections replace the whole kind). Both answer 404 unless
//   ORBITDESK_DEMO_ALLOW_RESET=1, exactly like /api/demo/reset.
//
// Continuity: ONE demo backend (one MemoryRecordStore) is created per server
// process and shared by every browser connection — the phone/laptop
// continuity demo shape. Closing a tab keeps the data; restarting the server
// reseeds it.
//
// Safety: this harness never bundles into dist/apps-script (scripts/build.mjs
// builds only src/app/entrypoints.ts and src/ui/main.ts), holds no
// credentials, and makes no outbound calls. The bundled demo backend replaces
// every live port with an in-memory simulation; fetch() exists only in the
// browser client.
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','..');
const host='127.0.0.1';
const port=4174;
const allowReset=process.env.ORBITDESK_DEMO_ALLOW_RESET==='1';
const maxBodyBytes=10*1024*1024;

// The demo backend is TypeScript, so bundle it to a temp ESM file once per
// server process and import it exactly once. One import = one backend
// instance = one shared workspace across all connections. The bundle lives in
// a fresh mkdtemp directory (random name, owner-only by platform defaults) so
// a predictable path cannot be raced or symlinked by another local user; the
// directory is removed on exit.
const backendDir=mkdtempSync(join(tmpdir(),'orbitdesk-demo-'));
const backendFile=join(backendDir,'demo-backend.mjs');
await build({entryPoints:[resolve(root,'src/app/demo-backend.ts')],bundle:true,format:'esm',platform:'node',outfile:backendFile,logLevel:'silent'});
const backendModule=await import(pathToFileURL(backendFile).href);
process.on('exit',()=>{try{rmSync(backendDir,{recursive:true,force:true})}catch{/* temp cleanup is best-effort */}});

let backend=backendModule.createDemoBackend();
let clientCache=null;
async function clientJs(){
 if(clientCache===null){
  clientCache=(await build({entryPoints:[resolve(root,'src/ui/main.ts')],bundle:true,write:false,format:'iife',target:'es2020',platform:'browser',logLevel:'silent'})).outputFiles[0].text;
 }
 return clientCache;
}
function json(res,status,body){
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
 res.end(JSON.stringify(body));
}
async function readJsonBody(req){
 let raw='';
 for await(const chunk of req){
  raw+=chunk;
  if(raw.length>maxBodyBytes)return {error:{status:413,body:{ok:false,error:{code:'INVALID_INPUT',message:'The request body is too large'}}}};
 }
 try{return {value:JSON.parse(raw||'')}}
 catch{return {error:{status:400,body:{ok:false,error:{code:'INVALID_INPUT',message:'The request body is not valid JSON'}}}}}
}
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url??'/',`http://${host}:${port}`);
  if(req.method==='POST'&&url.pathname==='/api/rpc'){
   const parsed=await readJsonBody(req);
   if(parsed.error)return json(res,parsed.error.status,parsed.error.body);
   try{return json(res,200,backend.handle(parsed.value))}
   catch(error){ // AppService returns ok:false for its own failures; this is the truly-unexpected path
    console.error('Demo RPC failed unexpectedly:',error);
    return json(res,500,{ok:false,error:{code:'INTERNAL_ERROR',message:'The demo server could not complete this request'}});
   }
  }
  if(req.method==='POST'&&(url.pathname==='/api/demo/reset'||url.pathname==='/__test/reset'||url.pathname==='/__test/state')){
   // One guard for every state-replacing hook: 404 unless the process was
   // started with ORBITDESK_DEMO_ALLOW_RESET=1 (and the server only ever
   // binds 127.0.0.1). Default deployments expose none of these.
   if(!allowReset)return json(res,404,{ok:false,error:{code:'NOT_FOUND',message:'Not found'}});
   const parsed=await readJsonBody(req);
   if(parsed.error)return json(res,parsed.error.status,parsed.error.body);
   if(url.pathname==='/api/demo/reset'){
    backend=backendModule.createDemoBackend();
    return json(res,200,{ok:true,reset:true,mode:'demo'});
   }
   if(url.pathname==='/__test/reset'){
    try{
     backend=backendModule.createDemoBackendFromState(parsed.value);
     const seeded=backend.handle({type:'state.get',requestId:'__test-reset',payload:{}});
     return json(res,200,{ok:true,reset:true,state:seeded.ok?seeded.state:null});
    }catch(error){
     return json(res,400,{ok:false,error:error&&error.code?{code:error.code,message:error.message}:{code:'INVALID_IMPORT',message:'The posted state could not be translated into demo store rows'}});
    }
   }
   const patched=backend.applyTestState(parsed.value);
   return json(res,patched.ok?200:400,patched);
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{ok:false,error:{code:'INVALID_INPUT',message:'Method not supported'}});
  if(url.pathname==='/client.js'){
   res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});
   res.end(await clientJs());return;
  }
  if(url.pathname==='/styles.css'){
   res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'no-store'});
   res.end(await readFile(resolve(root,'src/ui/styles.css')));return;
  }
  if(url.pathname==='/'||url.pathname==='/index.html'){
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
   res.end(await readFile(resolve(root,'src/ui/index.html')));return;
  }
  res.writeHead(404,{'content-type':'text/html; charset=utf-8'});
  res.end('<!doctype html><title>OrbitDesk demo</title><h1>404</h1><p>OrbitDesk local demo serves the UI at /.</p>');
 }catch(error){
  console.error('Demo server request failed:',error);
  if(!res.headersSent)res.writeHead(500,{'content-type':'application/json; charset=utf-8'});
  res.end(JSON.stringify({ok:false,error:{code:'INTERNAL_ERROR',message:'The demo server could not complete this request'}}));
 }
});
server.on('error',error=>{
 console.error('The OrbitDesk demo server could not start:',error.message);
 process.exit(1);
});
server.listen(port,host,()=>{
 console.log('OrbitDesk local demo listening on http://'+host+':'+port+' (bound to '+host+' only)');
 console.log('Sample data only. No Google account, live send, calendar write or AI call is possible.');
 console.log('Reset endpoints POST /api/demo/reset, /__test/reset, /__test/state: '+(allowReset?'ENABLED (ORBITDESK_DEMO_ALLOW_RESET=1)':'disabled (404); start with ORBITDESK_DEMO_ALLOW_RESET=1 to enable'));
 console.log('One shared workspace per server process: every browser connection sees the same data.');
});
