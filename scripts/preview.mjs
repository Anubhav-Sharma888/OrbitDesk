// `npm run preview` — starts the OrbitDesk local demo server on 127.0.0.1:4174
// and keeps it running until interrupted. This is the same harness the browser
// tests use (tests/browser/demo-server.mjs): the real UI bundle served over
// the same domain/RPC contract, backed by the real AppService domain modules
// with SIMULATED external providers and clearly labeled sample data
// (docs/spec.md: a local demo must be labeled and use the same domain/RPC
// contract with sample data, without pretending live integrations work).
//
// Safety: binds 127.0.0.1 only, holds no credentials, and cannot send email,
// write calendars or call AI — the demo backend's simulated ports never touch
// the network. Set ORBITDESK_DEMO_ALLOW_RESET=1 to enable the guarded
// POST /api/demo/reset endpoint (it answers 404 without the flag).
import {spawn} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const demoServer=resolve(here,'..','tests','browser','demo-server.mjs');

console.log('==============================================================');
console.log(' OrbitDesk local demo — sample data only');
console.log(' Opening http://127.0.0.1:4174 ... (press Ctrl+C to stop)');
console.log(' Same domain/RPC contract as the deployed web app, but every');
console.log(' external provider is simulated: no Google account is used,');
console.log(' no email is sent, no calendar changes and no AI calls.');
console.log('==============================================================');

const child=spawn(process.execPath,[demoServer],{stdio:'inherit'});
child.on('exit',(code,signal)=>{process.exit(signal?0:(code??0))});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{child.kill(signal)});
await new Promise(()=>{}); // stay alive until the demo server (or a signal) ends
