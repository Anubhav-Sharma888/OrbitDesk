// Static UI harness only. API responses in acceptance tests are explicitly demo fixtures.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
createServer(async (req,res)=>{
  try {
    if(req.url==='/client.js'){
      const result=await build({entryPoints:['src/ui/main.ts'],bundle:true,write:false,format:'iife',target:'es2020'});
      res.setHeader('content-type','text/javascript');res.end(result.outputFiles[0].text);return;
    }
    const file=req.url==='/styles.css'?'src/ui/styles.css':'src/ui/index.html';
    res.setHeader('content-type',req.url==='/styles.css'?'text/css':'text/html');
    res.end(await readFile(file));
  } catch {
    res.setHeader('content-type','text/html');res.end('<!doctype html><title>OrbitDesk UI harness</title><main>UI implementation pending</main>');
  }
}).listen(4174,'127.0.0.1');
