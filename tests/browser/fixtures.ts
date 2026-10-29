import type { UiState } from '../../src/shared/contracts';
export const now='2026-10-29T09:00:00.000Z';
export function demoState():UiState {
 return {
  app:{mode:'demo',owner:'demo@example.test',storageReady:true,aiConfigured:false,setupRequired:[]},
  settings:{timeZone:'Asia/Kolkata',automationEnabled:false,aiEnabled:false,aiConsent:false,accountDefaults:{},retentionDays:90},
  accounts:[{id:'personal',email:'demo@example.test',label:'Personal',status:'active',capabilities:['mail.read','mail.send','calendar.list','calendar.read','calendar.write'],paused:false,lastSync:now},{id:'school',email:'student@example.test',label:'Education',status:'reconnect',capabilities:['classroom.read'],paused:false,error:'Authorization expired'}],
  calendars:[{connectionId:'personal',id:'primary',summary:'Personal calendar',writable:true,accessRole:'owner'},{connectionId:'personal',id:'readonly',summary:'Shared read-only',writable:false,accessRole:'reader'}],
  tasks:[{id:'task-1',version:1,title:'Prepare circuits assignment',notes:'Bring your working notes',status:'open',kind:'classroom',officialDue:{kind:'unknown'},sourceRefs:[{connectionId:'school',type:'classroom',id:'source-1',courseId:'course-1',courseworkId:'work-1'}],confidence:'review',createdAt:now,updatedAt:now}],
  conversations:[{id:'chat-1',version:1,title:'Weekly planning',createdAt:now,updatedAt:now}],messages:[{id:'message-1',conversationId:'chat-1',role:'assistant',text:'Your saved workspace is ready.',version:1,createdAt:now}],
  drafts:[{id:'draft-1',version:1,connectionId:'personal',sourceId:'mail-1',threadId:'thread-1',messageId:'rfc-1',references:'',subject:'Project catch-up',to:['colleague@example.test'],body:'',userContent:'',status:'draft',rephrased:false,createdAt:now,updatedAt:now}],
  routes:[],activity:[],sources:[{connectionId:'school',id:'source-1',type:'classroom',title:'Prepare circuits assignment',text:'Published coursework. Due time has not been supplied.',receivedAt:now,updatedAt:now,courseId:'course-1',courseworkId:'work-1'},{connectionId:'personal',id:'mail-1',type:'gmail',title:'Project catch-up',text:'Could you share a short update?',sender:'colleague@example.test',threadId:'thread-1',receivedAt:now,updatedAt:now}]
 };
}


