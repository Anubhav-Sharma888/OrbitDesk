// Workspace RPC transport. In deployment this runs inside Apps Script's HTML
// service; the demo server exposes the same contract at /api/rpc. Both paths
// send a typed Command and receive an RpcResponse; the server re-derives the
// actor from the authenticated session, so nothing here grants capability.
import type {Command,RpcResponse} from '../shared/contracts.js';
export async function call(type:string,payload:Record<string,unknown>={}):Promise<RpcResponse> {
 const command:Command={type,requestId:crypto.randomUUID(),payload};
 const google=(window as any).google;
 if(google?.script?.run)return new Promise((resolve,reject)=>google.script.run.withSuccessHandler(resolve).withFailureHandler((e:any)=>reject(new Error(e?.message||'The server could not be reached.'))).rpc(command));
 const response=await fetch('/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)});
 if(!response.ok)throw new Error(`Workspace request failed (${response.status}). Try again.`);
 return response.json();
}
