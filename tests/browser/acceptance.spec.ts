import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Command, ReplyDraft, RoutingRule, UiState } from '../../src/shared/contracts';

import { demoState, now } from './fixtures';

// Deliberate UI contract fixture: live Google services are never contacted.
class DemoRpc {
 state=demoState(); commands:Command[]=[];
 private initialized=false;private context?:BrowserContext;
 async patch(patch:Partial<UiState>){Object.assign(this.state,patch);if(process.env.ORBITDESK_BASE_URL){const result=await this.context!.request.post('/__test/state',{data:patch});expect(result.ok()).toBe(true);}}
 async attach(context:BrowserContext){this.context=context;if(process.env.ORBITDESK_BASE_URL){
   if(!this.initialized){const response=await context.request.post('/__test/reset',{data:this.state});expect(response.ok()).toBe(true);this.initialized=true;}
   context.on('request',request=>{if(new URL(request.url()).pathname==='/api/rpc'&&request.method()==='POST')this.commands.push(request.postDataJSON() as Command)});return;
  }await context.route('**/api/rpc',async route=>{
   const command=route.request().postDataJSON() as Command;
   this.commands.push(command);
   const p=command.payload as any;
   let value:unknown;
   const error=(code:string,message:string)=>route.fulfill({json:{ok:false,error:{code,message},state:this.state}});
   if(command.type==='task.dismiss'||command.type==='task.restore'||command.type==='task.complete'){
    const task=this.state.tasks.find(t=>t.id===p.id)!;if(task.version!==p.version)return error('VERSION_CONFLICT','This item changed on another device');task.status=command.type==='task.dismiss'?'dismissed':command.type==='task.complete'?'complete':'open';task.version++;
   } else if(command.type==='task.update'){const task=this.state.tasks.find(t=>t.id===p.id)!;if(task.version!==p.version)return error('VERSION_CONFLICT','This item changed on another device');Object.assign(task,p.patch,{version:task.version+1});}
   else if(command.type==='task.create') this.state.tasks.push({id:`task-${this.state.tasks.length+1}`,version:1,title:p.title,notes:p.notes||'',kind:'manual',status:'open',officialDue:p.due||{kind:'unknown'},sourceRefs:[],confidence:'clear',createdAt:now,updatedAt:now});
   else if(command.type==='message.append')this.state.messages.push({id:`message-${this.state.messages.length+1}`,conversationId:p.conversationId,text:p.text,role:'user',version:1,createdAt:now});
   else if(command.type==='conversation.create'){const c={id:`chat-${this.state.conversations.length+1}`,title:p.title,version:1,createdAt:now,updatedAt:now};this.state.conversations.push(c);value=c;}
   else if(command.type==='draft.save'){
     const draft=this.state.drafts.find(d=>d.id===p.id)!;
     if(draft.version!==p.version)return error('VERSION_CONFLICT','This item changed on another device');
     // Mirrors DraftService.save (src/conversations/drafts.ts): an explicit save clears the imported-review flag.
     Object.assign(draft,{body:p.body,userContent:p.userContent,to:p.to||draft.to,version:draft.version+1,status:'draft',importedUnreviewed:false});
   } else if(command.type==='draft.send'){
     const draft=this.state.drafts.find(d=>d.id===p.id)!;
     if(draft.version!==p.version)return error('VERSION_CONFLICT','This item changed on another device');
     if(!draft.userContent.trim()||!draft.body.trim()||p.instruction!=='send')return error('CONTENT_REQUIRED','Add your reply content before sending.');
     draft.status='sent';draft.version++;
   } else if(command.type==='draft.rephrase'){
     // Mirrors AiProposalService: the proposal comes back for display only; nothing is saved or sent.
     value={summary:'Suggested wording',tasks:[],replyText:'Here is a suggested wording from the AI proposal.'};
   } else if(command.type==='route.preview'){
     // Mirrors RoutingService.preview: writability problems return ok:true inside value.errors, not an RPC error.
     const rule=p.rule as RoutingRule;
     value=rule.decision.destinations.some(d=>d.calendarId==='readonly')?{decision:rule.decision,reason:'Item override',errors:['The selected calendar is unavailable or does not grant supported write access']}:{matched:1,destinationNames:['Personal calendar'],decisions:[{taskId:'task-1',title:'Prepare circuits assignment',decision:rule.decision}]};
   } else if(command.type==='route.save'){
     const rule=p.rule as RoutingRule;
     this.state.routes.push({...rule,id:rule.id||'rule-1',version:1});
   } else if(command.type==='settings.save')this.state.settings=p.settings;
   await route.fulfill({json:{ok:true,state:this.state,value}});
  });}
}
async function open(page:Page,view:string){await page.getByRole('button',{name:view,exact:true}).click();}

test('phoneConversationContinuesOnLaptop',async({browser})=>{
 const rpc=new DemoRpc(); const phone=await browser.newContext({viewport:{width:390,height:844}});const laptop=await browser.newContext();await rpc.attach(phone);await rpc.attach(laptop);
 const p=await phone.newPage();await p.goto('/');await open(p,'Chat');await p.getByLabel('Message').fill('Keep time for circuits after lunch');await p.getByRole('button',{name:'Save message',exact:true}).click();await expect(p.getByText('Keep time for circuits after lunch',{exact:true})).toBeVisible();
 const q=await laptop.newPage();await q.goto('/');await open(q,'Chat');await expect(q.getByText('Keep time for circuits after lunch',{exact:true})).toBeVisible();await phone.close();await laptop.close();
});
test('staleDraftShowsConflict',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Replies');await page.getByLabel('Your reply content').fill('The prototype is ready.');await page.getByLabel('Draft body').fill('The prototype is ready.');rpc.state.drafts[0].version=2;await rpc.patch({drafts:rpc.state.drafts});
 await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByRole('alert')).toContainText(/changed on another device|changed in another session/);await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('manualDismissSurvivesSync',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Tasks');await page.getByRole('button',{name:'Dismiss Prepare circuits assignment'}).click();await page.getByRole('button',{name:'Sync now',exact:true}).click();await page.getByRole('button',{name:'Dismissed',exact:true}).click();await expect(page.getByText('Prepare circuits assignment',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Restore Prepare circuits assignment'})).toBeVisible();
});
test('rulePreviewShowsDestination',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Classwork to personal');await page.getByLabel('Destination calendar').selectOption('personal|primary');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByTestId('route-preview')).toContainText('Personal calendar');
});
test('unwritableCalendarShowsError',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Invalid destination');await page.getByLabel('Destination calendar').selectOption('personal|readonly');await page.getByLabel('Routing action').selectOption('automatic');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByRole('alert')).toContainText(/not writable|does not grant supported write access/);
});
test('missingReplyContentDoesNotSend',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Replies');await page.getByRole('button',{name:'Review & send',exact:true}).click();await expect(page.getByRole('alert')).toContainText('reply content');await expect(page.getByRole('dialog')).toHaveCount(0);expect(rpc.commands.filter(c=>c.type==='draft.send')).toHaveLength(0);
});
test('mobileLayoutHasUsableControls',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByText('Demo workspace',{exact:false}).first()).toBeVisible();await open(page,'Tasks');await page.getByRole('button',{name:'Add task',exact:true}).click();await page.getByLabel('Task title').fill('Phone task');await page.getByRole('button',{name:'Create task',exact:true}).click();await expect(page.getByText('Phone task',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('literalUntrustedContent',async({page,context})=>{
 const rpc=new DemoRpc();rpc.state.tasks[0].title='<img src=x onerror="window.untrustedExecuted=true">';rpc.state.tasks[0].notes='<script>window.untrustedExecuted=true</script>';await rpc.attach(context);await page.goto('/');await open(page,'Tasks');await expect(page.getByText('<img src=x onerror="window.untrustedExecuted=true">',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).untrustedExecuted)).toBeUndefined();expect(await page.locator('img[src="x"]').count()).toBe(0);
});
test('replyConfirmationBindsExactSavedVersion',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Replies');await page.getByLabel('Your reply content').fill('I can join on Friday.');await page.getByLabel('Draft body').fill('I can join on Friday.');await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('button',{name:'Review & send',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toContainText('colleague@example.test');await expect(dialog).toContainText('I can join on Friday.');await expect(dialog).toContainText('Version 2');await dialog.getByLabel('I authorize this exact message').check();await dialog.getByRole('button',{name:'Send this exact reply',exact:true}).click();await expect(page.getByText('Sent',{exact:true})).toBeVisible();expect(rpc.commands.find(c=>c.type==='draft.send')?.payload).toEqual({id:'draft-1',version:2,instruction:'send'});
});


// Item overrides persist through the backend: task.update accepts patch.override
// (src/app/service.ts task.update schema) and state.get returns it after reload.
// Without ORBITDESK_BASE_URL the route mock below mirrors that same contract.
test('itemOverrideRoundTrip',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Tasks');
 await page.getByRole('button',{name:'Prepare circuits assignment',exact:true}).click();
 await page.getByLabel('Item routing destination').selectOption('personal|primary');
 await page.getByRole('button',{name:'Save item routing override',exact:true}).click();
 await expect(page.getByText('Override: always routes to Personal calendar',{exact:true})).toBeVisible();
 expect(rpc.commands.filter(c=>c.type==='task.update')[0].payload).toMatchObject({id:'task-1',version:1,patch:{override:{mode:'automatic',destinations:[{connectionId:'personal',calendarId:'primary'}]}}});
 await page.reload();
 await page.getByRole('button',{name:'Prepare circuits assignment',exact:true}).click();
 await expect(page.getByText('Override: always routes to Personal calendar',{exact:true})).toBeVisible();
});
// Imported drafts stay blocked until an explicit save clears importedUnreviewed
// (operations.md:17; DraftService.save clears it and bumps the version).
test('importedDraftShowsReviewGate',async({page,context})=>{
 const rpc=new DemoRpc();rpc.state.drafts[0].importedUnreviewed=true;await rpc.attach(context);await page.goto('/');await open(page,'Replies');
 await expect(page.getByText('was imported and has not been reviewed',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:'Review & send',exact:true})).toBeDisabled();
 await page.getByLabel('Your reply content').fill('Reviewed by me and ready.');await page.getByLabel('Draft body').fill('Reviewed by me and ready.');
 await page.getByRole('button',{name:'Review and keep the imported draft',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('reviewed and saved');
 await expect(page.getByText('was imported and has not been reviewed',{exact:false})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
 expect(rpc.commands.filter(c=>c.type==='draft.save')[0].payload).toMatchObject({id:'draft-1',version:1,to:['colleague@example.test'],userContent:'Reviewed by me and ready.'});
});
// AI rephrase proposals run in mock mode only: app.aiConfigured is derived server-side
// from a restricted key, so the real demo backend keeps rephrase fail-closed (button disabled).
test('rephraseShowsSuggestedWordingWithoutSaving',async({page,context})=>{
 test.skip(Boolean(process.env.ORBITDESK_BASE_URL),'Rephrase needs a configured AI key; the demo backend keeps AI fail-closed, so the button stays disabled there');
 const rpc=new DemoRpc();rpc.state.app.aiConfigured=true;rpc.state.settings={...rpc.state.settings,aiEnabled:true,aiConsent:true};await rpc.attach(context);await page.goto('/');await open(page,'Replies');
 await page.getByLabel('Your reply content').fill('I can join on Friday.');await page.getByLabel('Draft body').fill('I can join on Friday.');
 await page.getByRole('button',{name:'Rephrase saved draft',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Suggested wording (not saved): Here is a suggested wording from the AI proposal.');
 await expect(page.getByLabel('Draft body')).toHaveValue('');
 expect(rpc.commands.filter(c=>c.type==='draft.save')).toHaveLength(0);expect(rpc.commands.filter(c=>c.type==='draft.send')).toHaveLength(0);
});
// Dead accounts expose no actions: Pause/Disconnect/background access always fail server-side
// (NO_CONNECTION / MANUAL_CONNECTION_REQUIRED) for status:'disconnected'.
test('disconnectedAccountHidesDeadActions',async({page,context})=>{
 const rpc=new DemoRpc();rpc.state.accounts=[...rpc.state.accounts,{id:'gone',email:'old@example.test',label:'Old',status:'disconnected',capabilities:['mail.read'],paused:false}];await rpc.attach(context);await page.goto('/');await open(page,'Accounts');
 const card=page.locator('.account-grid .panel',{hasText:'old@example.test'});
 await expect(card.getByText('Disconnected. Connect again to use this account.',{exact:true})).toBeVisible();
 await expect(card.getByRole('button')).toHaveCount(0);
});
test('rulePreviewKeepsUnsavedEditorValues',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Keep this unsaved name');await page.getByLabel('Destination calendar').selectOption('personal|primary');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByTestId('route-preview')).toContainText('Personal calendar');await expect(page.getByLabel('Rule name')).toHaveValue('Keep this unsaved name');
});
