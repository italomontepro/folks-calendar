import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../server/store.js';
import {createWorker} from '../server/worker.js';
import {channels,templates,templateBody,helenaRequest} from '../server/helena.js';
import {hookInput,eventInput} from '../server/validation.js';
async function fixture(fn) {
 const dir=mkdtempSync(join(tmpdir(),'folks-helena-')),store=await openStore(dir),workspace=store.db.prepare('SELECT id FROM workspaces').get().id;
 try {await fn(store,workspace);} finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
}
const makeEvent=(extra={})=>({id:randomUUID(),revision:randomUUID(),title:'Consulta',contactName:'Ana',phone:'5592999999999',assigneeName:'Bia',assigneePhone:'5592888888888',location:'Centro',start:new Date(Date.now()+3600000).toISOString(),end:new Date(Date.now()+7200000).toISOString(),category:'meeting',reminder:0,...extra});
const makeHook=(extra={})=>({id:randomUUID(),kind:'helena',name:'Confirmação',revision:randomUUID(),integrationRevision:'rev',from:'5592111111111',templateId:randomUUID(),channelId:randomUUID(),enabled:true,createdAt:new Date(Date.now()-86400000).toISOString(),timezone:'America/Manaus',recipient:'contact',parameters:{'[p1]':'{{nome}}','[p2]':'{{hora}}'},categories:[],triggers:['event.created'],...extra});
test('normalizes actual HELENA channel and template responses, with pagination',async()=>{
 const available=await channels('secret',async()=>[{id:'c',active:true,type:'CLOUDAPI_WHATSAPP',number:'+55|92911111111'},{id:'z',active:true,type:'ZAPI_WHATSAPP',number:'1'}]);assert.equal(available.length,1);assert.equal(available[0].number,'5592911111111');
 let calls=0;const list=await templates('secret','c',async(_,path)=>{calls++;assert.ok(path.includes('IncludeDetails=All'));return {items:[{id:String(calls),active:true,status:'APPROVED',channelId:'c',params:[{name:'[p1]'}]},{id:'wrong',active:true,status:'APPROVED',channelId:'other'}],hasMorePages:calls===1};});assert.equal(list.length,2);assert.equal(calls,2);
});
test('validates recipients and maps template parameters in the selected timezone',()=>{
 const event=makeEvent({start:'2030-01-01T14:00:00Z',end:'2030-01-01T15:00:00Z'}),hook=makeHook();
 const body=templateBody(hook,event,'delivery');assert.equal(body.parameters['[p1]'],'Ana');assert.equal(body.parameters['[p2]'],'10:00');assert.equal(body.senderId,'delivery');
 assert.equal(templateBody({...hook,recipient:'assignee'},event,'d').to,event.assigneePhone);
 assert.throws(()=>templateBody(hook,{...event,contactName:''},'d'),/nome/);
 assert.throws(()=>eventInput({...event,phone:'invalid'}),/WhatsApp/);
 assert.throws(()=>hookInput({...hook,parameters:{p:'{{missing}}'}}),/desconhecida/);
 assert.equal(hookInput({...hook,reminderMinutes:120}).reminderMinutes,120);
});
test('HTTP errors never expose secrets; ambiguous POST cannot be blindly retried',async()=>{
 const fetcher=async(url,options)=>{assert.equal(url,'https://api.wts.chat/chat/v1/send/template');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer secret');throw new Error('secret');};
 await assert.rejects(helenaRequest('secret','send/template',{},fetcher),e=>e.ambiguous&&!e.message.includes('secret'));
 await assert.rejects(helenaRequest('secret','send/template',{},async()=>({ok:false,status:429})),e=>e.retryable&&!e.ambiguous);
 await assert.rejects(helenaRequest('secret','send/template',{},async()=>({ok:false,status:500})),e=>e.ambiguous);
});
test('worker sends once, keeps accounts isolated, persists acceptance, and skips disabled events',async()=>fixture(async(store,ws)=>{
 const {db,put}=store,other=randomUUID();db.prepare('INSERT INTO workspaces(id,name,created_at) VALUES (?,?,?)').run(other,'Outro',new Date().toISOString());
 db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?)').run(ws,'account-A','rev','secret-a','1f08f5c8-c4ae-4730-b820-871e7d8af275');db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?)').run(other,'account-B','rev','secret-b','1f08f5c8-c4ae-4730-b820-871e7d8af275');
 const hook=makeHook(),event=makeEvent();put('hooks',hook,ws);put('hooks',makeHook(),other);put('events',event,ws);
 const calls=[],worker=createWorker(store,{helena:async(token,path,body)=>{calls.push({token,body});return {id:'provider-id',status:'QUEUED'};}});
 worker.enqueue('event.created',event,ws);worker.enqueue('event.created',{...event,messagesEnabled:false},ws);await worker.tick();await worker.tick();assert.equal(calls.length,1);assert.equal(calls[0].token,'account-A');
 const job=db.prepare('SELECT * FROM jobs').get();assert.equal(job.status,'accepted');assert.equal(job.provider_id,'provider-id');assert.equal(job.integration_revision,'rev');assert.ok(!job.payload.includes('account-A'));
}));
test('two independent reminders fire only once and never replay before activation',async()=>fixture(async(store,ws)=>{
 const {db,put}=store;db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?)').run(ws,'account-A','rev','secret','1f08f5c8-c4ae-4730-b820-871e7d8af275');
 const a=makeHook({triggers:['event.reminder'],reminderMinutes:120}),b=makeHook({triggers:['event.reminder'],reminderMinutes:1440});put('hooks',a,ws);put('hooks',b,ws);
 put('events',makeEvent({start:new Date(Date.now()+120*60000-1000).toISOString()}),ws);
 put('events',makeEvent({start:new Date(Date.now()+1440*60000-1000).toISOString()}),ws);
 let sends=0;const worker=createWorker(store,{helena:async()=>{sends++;return {id:randomUUID(),status:'QUEUED'};}});await worker.tick();await worker.tick();assert.equal(sends,2);
 const c=makeHook({triggers:['event.reminder'],reminderMinutes:120,createdAt:new Date(Date.now()+1000).toISOString()});put('hooks',c,ws);await worker.tick();assert.equal(sends,2);
}));
test('cancels stale reminders and changed credentials; uncertain sends survive restart without duplication',async()=>fixture(async(store,ws)=>{
 const {db,put}=store;db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?)').run(ws,'account-A','rev','secret','1f08f5c8-c4ae-4730-b820-871e7d8af275');const hook=makeHook(),event=makeEvent();put('hooks',hook,ws);put('events',event,ws);
 let calls=0;let worker=createWorker(store,{helena:async()=>{calls++;throw Object.assign(new Error('Incerto'),{ambiguous:true});}});
 worker.enqueue('event.created',event,ws);await worker.tick();assert.equal(db.prepare('SELECT status FROM jobs').get().status,'unknown');await worker.tick();assert.equal(calls,1);
 worker.enqueue('event.reminder',event,ws,hook.id);put('events',{...event,revision:'new'},ws);await worker.tick();assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='cancelled'").get().n,1);
 worker.enqueue('event.created',event,ws);db.prepare("UPDATE integrations SET revision='changed'").run();await worker.tick();assert.equal(calls,1);
 db.prepare("UPDATE jobs SET status='sending' WHERE status='unknown'").run();worker=createWorker(store,{helena:async()=>{calls++;}});await worker.tick();assert.equal(calls,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='unknown'").get().n,1);
}));
