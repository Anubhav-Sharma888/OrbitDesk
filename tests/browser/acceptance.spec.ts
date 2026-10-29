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
    const task=this.state.tasks.find(t=>t.id===p.id)!;if(task.version!==p.version)return error('CONFLICT','This task changed in another session. Review the latest version.');task.status=command.type==='task.dismiss'?'dismissed':command.type==='task.complete'?'complete':'open';task.version++;
   } else if(command.type==='task.update'){const task=this.state.tasks.find(t=>t.id===p.id)!;if(task.version!==p.version)return error('CONFLICT','This task changed in another session.');Object.assign(task,p.patch,{version:task.version+1});}
   else if(command.type==='task.create') this.state.tasks.push({id:`task-${this.state.tasks.length+1}`,version:1,title:p.title,notes:p.notes||'',kind:'manual',status:'open',officialDue:p.due||{kind:'unknown'},sourceRefs:[],confidence:'clear',createdAt:now,updatedAt:now});
   else if(command.type==='message.append')this.state.messages.push({id:`message-${this.state.messages.length+1}`,conversationId:p.conversationId,text:p.text,role:'user',version:1,createdAt:now});
   else if(command.type==='conversation.create'){const c={id:`chat-${this.state.conversations.length+1}`,title:p.title,version:1,createdAt:now,updatedAt:now};this.state.conversations.push(c);value=c;}
   else if(command.type==='draft.save'){
     const draft=this.state.drafts.find(d=>d.id===p.id)!;
     if(draft.version!==p.version)return error('CONFLICT','This draft changed in another session. Review the latest version before saving.');
     Object.assign(draft,{body:p.body,userContent:p.userContent,to:p.to||draft.to,version:draft.version+1});
   } else if(command.type==='draft.send'){
     const draft=this.state.drafts.find(d=>d.id===p.id)!;
     if(draft.version!==p.version)return error('CONFLICT','This draft changed in another session.');
     if(!draft.userContent.trim()||!draft.body.trim()||p.instruction!=='send')return error('CONTENT_REQUIRED','Add your reply content before sending.');
     draft.status='sent';draft.version++;
   } else if(command.type==='route.preview'||command.type==='route.save'){
     const rule=p.rule as RoutingRule;
     if(rule.decision.destinations.some(d=>d.calendarId==='readonly'))return error('CALENDAR_NOT_WRITABLE','Shared read-only is not writable. Choose an authorized writable calendar.');
     if(command.type==='route.save')this.state.routes.push({...rule,id:rule.id||'rule-1',version:1});
     value={matched:1,destinationNames:['Personal calendar'],decisions:[{taskId:'task-1',title:'Prepare circuits assignment',decision:rule.decision}]};
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
 await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByRole('alert')).toContainText('changed in another session');await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('manualDismissSurvivesSync',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Tasks');await page.getByRole('button',{name:'Dismiss Prepare circuits assignment'}).click();await page.getByRole('button',{name:'Sync now',exact:true}).click();await page.getByRole('button',{name:'Dismissed',exact:true}).click();await expect(page.getByText('Prepare circuits assignment',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Restore Prepare circuits assignment'})).toBeVisible();
});
test('rulePreviewShowsDestination',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Classwork to personal');await page.getByLabel('Destination calendar').selectOption('personal|primary');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByTestId('route-preview')).toContainText('Personal calendar');
});
test('unwritableCalendarShowsError',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Invalid destination');await page.getByLabel('Destination calendar').selectOption('personal|readonly');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByRole('alert')).toContainText('not writable');
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


test('itemRoutingOverrideIsExplicitAndCanBeCleared',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Tasks');await page.getByRole('button',{name:'Prepare circuits assignment',exact:true}).click();
 await expect(page.getByText('Published coursework. Due time has not been supplied.',{exact:true})).toBeVisible();
 await page.getByLabel('This task routing').selectOption('review');await page.getByLabel('This task destination').selectOption('personal|primary');await page.getByRole('button',{name:'Save item override',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('override');await page.getByLabel('This task routing').selectOption('inherit');await page.getByRole('button',{name:'Save item override',exact:true}).click();
 const updates=rpc.commands.filter(c=>c.type==='task.update');expect(updates[0].payload).toMatchObject({id:'task-1',version:1,patch:{override:{mode:'review',destinations:[{connectionId:'personal',calendarId:'primary'}]}}});expect(updates[1].payload).toMatchObject({version:2,patch:{override:null}});
});
test('rulePreviewKeepsUnsavedEditorValues',async({page,context})=>{
 const rpc=new DemoRpc();await rpc.attach(context);await page.goto('/');await open(page,'Routing');await page.getByLabel('Rule name').fill('Keep this unsaved name');await page.getByLabel('Destination calendar').selectOption('personal|primary');await page.getByRole('button',{name:'Preview rule',exact:true}).click();await expect(page.getByTestId('route-preview')).toContainText('Personal calendar');await expect(page.getByLabel('Rule name')).toHaveValue('Keep this unsaved name');
});
