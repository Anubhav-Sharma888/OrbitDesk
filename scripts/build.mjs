import {build} from 'esbuild';
import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
await mkdir('dist/apps-script',{recursive:true});await mkdir('dist/web',{recursive:true});
const vendor=await readFile('vendor/OAuth2.gs','utf8');
if(createHash('sha256').update(vendor).digest('hex')!=='73e240cdf2ad217c97fbd864e150ffc380c2220b0f040fcaa6143a81ef58ad0d')throw new Error('OAuth2 vendor integrity mismatch');
const server=await build({entryPoints:['src/app/entrypoints.ts'],bundle:true,format:'iife',globalName:'OrbitDeskServer',target:'es2020',platform:'neutral',write:false});
// Testable twin: same entrypoint as ESM so verification can import it without
// evaluating script text dynamically. Behavior checks run against this build;
// the deployed IIFE above is additionally checked statically below.
await build({entryPoints:['src/app/entrypoints.ts'],bundle:true,format:'esm',target:'es2020',platform:'neutral',outfile:'dist/testable/server.mjs'});
const globals=['doGet','rpc','authCallback','scheduledSync'];
const wrappers=globals.map(name=>'function '+name+'(argument) { return OrbitDeskServer.'+name+'(argument); }').join('\n');
await writeFile('dist/apps-script/Code.gs',vendor+'\n'+server.outputFiles[0].text+'\n'+wrappers+'\n');
await copyFile('src/app/appsscript.json','dist/apps-script/appsscript.json');
let html='<!doctype html><html lang="en"><meta charset="utf-8"><title>OrbitDesk</title><body><h1>OrbitDesk setup</h1><p>The application build is in progress. Accounts are not connected.</p></body></html>';
if(existsSync('src/ui/index.html')&&existsSync('src/ui/main.ts')) {
 await build({entryPoints:['src/ui/main.ts'],bundle:true,format:'iife',target:'es2020',platform:'browser',outfile:'dist/web/client.js'});
 html=await readFile('src/ui/index.html','utf8');
 await copyFile('src/ui/styles.css','dist/web/styles.css');
 await writeFile('dist/web/index.html',html);
 const js=(await readFile('dist/web/client.js','utf8')).replace(/<\/script/gi,'<\\/script');
 const css=await readFile('src/ui/styles.css','utf8');
 html=html.replace(/<link\b[^>]*href=["']\/styles\.css["'][^>]*>/i,'<style>'+css+'</style>')
  .replace(/<script\b[^>]*src=["']\/client\.js["'][^>]*>\s*<\/script>/i,'<script>'+js+'</script>');
}
await writeFile('dist/apps-script/Index.html',html);
console.log('Built Apps Script globals and browser assets (no credentials included).');
