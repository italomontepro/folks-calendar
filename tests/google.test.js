import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../server/store.js';
import {eventInput,emailList} from '../server/validation.js';
import {createGoogleEvent,updateGoogleEvent,deleteGoogleEvent} from '../server/google.js';

process.env.GOOGLE_CLIENT_ID='test-client-id';
process.env.GOOGLE_CLIENT_SECRET='test-client-secret';

async function fixture(fn) {
 const dir=mkdtempSync(join(tmpdir(),'folks-google-')),store=await openStore(dir),workspace=store.db.prepare('SELECT id FROM workspaces').get().id;
 try {await fn(store,workspace);} finally {store.db.close();rmSync(dir,{recursive:true,force:true});}
}
const connect=(db,workspace)=>db.prepare('INSERT INTO google_integrations (workspace_id,refresh_token,calendar_id,account_email,created_at,updated_at) VALUES (?,?,?,?,?,?)')
 .run(workspace,'refresh-token','primary','agenda@folks.com.br',new Date().toISOString(),new Date().toISOString());
const baseEvent={title:'Consulta',start:'2030-01-01T14:00:00.000Z',end:'2030-01-01T15:00:00.000Z',location:'Centro'};

// Captura as chamadas e responde token + recurso, para afirmar método, URL e corpo enviados ao Google.
function stubFetch(calls,resource={id:'remote-id'}) {
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options={})=>{
  calls.push({url:String(url),method:options.method||'GET',body:typeof options.body==='string'&&options.body.startsWith('{')?JSON.parse(options.body):null});
  if (String(url).includes('oauth2.googleapis.com')) return {ok:true,json:async()=>({access_token:'token'})};
  return {ok:true,json:async()=>resource};
 };
 return ()=>{globalThis.fetch=original;};
}

test('accepts several invitees, trims duplicates and rejects malformed addresses',()=>{
 assert.deepEqual(emailList(' a@x.com , b@y.com ; a@x.com '),['a@x.com','b@y.com']);
 assert.equal(eventInput({...baseEvent,email:'a@x.com,b@y.com'}).email,'a@x.com, b@y.com');
 assert.equal(eventInput({...baseEvent,email:''}).email,'');
 assert.throws(()=>eventInput({...baseEvent,email:'a@x.com, quebrado'}),/e-mails válidos/);
});

test('creating sends every invitee as an attendee on the connected calendar',async()=>fixture(async(store,workspace)=>{
 connect(store.db,workspace);
 const calls=[],restore=stubFetch(calls);
 try {
  const event={...eventInput({...baseEvent,email:'a@x.com,b@y.com'}),id:randomUUID()};
  const remote=await createGoogleEvent(store.db,workspace,event);
  assert.equal(remote.id,'remote-id');
  const call=calls.at(-1);
  assert.equal(call.method,'POST');
  assert.ok(call.url.endsWith('/calendars/primary/events?sendUpdates=all'));
  assert.deepEqual(call.body.attendees,[{email:'a@x.com'},{email:'b@y.com'}]);
  assert.equal(call.body.start.dateTime,'2030-01-01T14:00:00.000Z');
 } finally {restore();}
}));

test('editing and deleting reach the same remote event and notify the invitees',async()=>fixture(async(store,workspace)=>{
 connect(store.db,workspace);
 const calls=[],restore=stubFetch(calls);
 try {
  const event={...eventInput({...baseEvent,title:'Remarcada',email:'a@x.com'}),googleEventId:'remote-id'};
  await updateGoogleEvent(store.db,workspace,event);
  let call=calls.at(-1);
  assert.equal(call.method,'PATCH');
  assert.ok(call.url.endsWith('/events/remote-id?sendUpdates=all'));
  assert.equal(call.body.summary,'Remarcada');

  await deleteGoogleEvent(store.db,workspace,event);
  call=calls.at(-1);
  assert.equal(call.method,'DELETE');
  assert.ok(call.url.endsWith('/events/remote-id?sendUpdates=all'));
 } finally {restore();}
}));

test('workspaces without the integration stay untouched and never call Google',async()=>fixture(async(store,workspace)=>{
 const calls=[],restore=stubFetch(calls);
 try {
  const event={...eventInput({...baseEvent,email:'a@x.com'}),googleEventId:'remote-id'};
  assert.equal(await createGoogleEvent(store.db,workspace,event),null);
  assert.equal(await updateGoogleEvent(store.db,workspace,event),null);
  assert.equal(await deleteGoogleEvent(store.db,workspace,event),null);
  assert.equal(calls.length,0);
 } finally {restore();}
}));

test('a failing Google call surfaces its message instead of a generic error',async()=>fixture(async(store,workspace)=>{
 connect(store.db,workspace);
 const original=globalThis.fetch;
 globalThis.fetch=async url=>String(url).includes('oauth2.googleapis.com')
  ? {ok:true,json:async()=>({access_token:'token'})}
  : {ok:false,json:async()=>({error:{message:'Calendar usage limits exceeded.'}})};
 try {
  await assert.rejects(createGoogleEvent(store.db,workspace,{...eventInput(baseEvent)}),/Calendar usage limits exceeded/);
 } finally {globalThis.fetch=original;}
}));
