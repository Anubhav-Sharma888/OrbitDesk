import {requireOwner,configuredOwner,productionBroker,safeError} from './runtime.js';
export function doGet(_e?:unknown):GoogleAppsScript.HTML.HtmlOutput {
 try {requireOwner();return HtmlService.createTemplateFromFile('Index').evaluate().setTitle('OrbitDesk').addMetaTag('viewport','width=device-width, initial-scale=1')}
 catch {return HtmlService.createHtmlOutput('<h1>Owner access required</h1><p>Open OrbitDesk while signed into its owner account.</p>')}
}
export function rpc(_command:unknown):unknown {
 try {requireOwner();return {ok:false,error:{code:'SETUP_REQUIRED',message:'Application storage is not configured yet'}}}
 catch(e){return {ok:false,error:safeError(e)}}
}
export function authCallback(e:{parameter:Record<string,string>}):GoogleAppsScript.HTML.HtmlOutput {
 try {
  // Apps Script validates the signed state token before dispatching this callback.
  // The pending request is additionally owner-bound, expiring and single-use.
  const owner=configuredOwner();
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==owner)throw Error('Wrong callback execution identity');
  const result=productionBroker().completeConnection(owner,e.parameter);
  return HtmlService.createHtmlOutput(result.status==='connected'?'<h1>Google account connected</h1><p>Return to OrbitDesk and refresh account status.</p>':'<h1>Access was not granted</h1><p>Your other accounts were not changed.</p>');
 } catch {return HtmlService.createHtmlOutput('<h1>Connection could not be completed</h1><p>Return to OrbitDesk and start a new connection request.</p>')}
}
export function scheduledSync(_e?:unknown):unknown {return {status:'setup_required'}}
