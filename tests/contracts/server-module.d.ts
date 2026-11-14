// Type surface of the testable ESM twin emitted by scripts/build.mjs.
declare module '*/dist/testable/server.mjs' {
 export function doGet(e?:unknown):unknown;
 export function rpc(command:unknown):unknown;
 export function authCallback(e:{parameter:Record<string,string>}):unknown;
 export function scheduledSync(e?:unknown):unknown;
}
