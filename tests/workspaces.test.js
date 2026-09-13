import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'folks-tenants-'));
const dbPath=join(dir,'calendar.sqlite');
const seed=new DatabaseSync(dbPath);
seed.exec(`CREATE TABLE events (id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE hooks (id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE jobs(id TEXT PRIMARY KEY,hook TEXT NOT NULL,payload TEXT NOT NULL,attempts INTEGER DEFAULT 0,next INTEGER NOT NULL,status TEXT DEFAULT 'pending',error TEXT,created TEXT NOT NULL); CREATE TABLE fired(key TEXT PRIMARY KEY);`);
const future={title:'Evento legado',start:'2030-01-01T14:00:00Z',end:'2030-01-01T15:00:00Z',reminder:15,category:'meeting',id:'legacy-event',revision:'legacy-revision'};
seed.prepare('INSERT INTO events VALUES (?,?)').run(future.id,JSON.stringify(future));
seed.prepare('INSERT INTO hooks VALUES (?,?)').run('legacy-hook',JSON.stringify({id:'legacy-hook',name:'Legado',url:'https://127.0.0.1',secret:'preserve-this-secret',triggers:['event.created'],enabled:false}));
seed.prepare('INSERT INTO jobs (id,hook,payload,next,created,status) VALUES (?,?,?,?,?,?)').run('legacy-job','legacy-hook',JSON.stringify({id:'legacy-job',type:'event.created',data:future}),0,new Date().toISOString(),'delivered');
seed.prepare('INSERT INTO fired VALUES (?)').run('legacy-event:legacy-revision:event.reminder');seed.close();
let server,owner,wsA,wsB,editor,viewer,admin,userB,eventA,eventB,hookA,hookB;
async function start(){server=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'3098',DATA_DIR:dir,ADMIN_EMAIL:'owner@folks.test',APP_PASSWORD:'test-owner-password',NODE_ENV:'production'},stdio:'pipe'});await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Server timeout '+output)),10000);server.stdout.on('data',chunk=>{output+=chunk;if(output.includes('Folks Calendar:')){clearTimeout(timer);resolve();}});server.stderr.on('data',chunk=>output+=chunk);server.on('exit',code=>{if(code){clearTimeout(timer);reject(new Error(output));}});});}
async function stop(){const done=new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await done;}
async function api(path,{token=owner,method='GET',body}={}){const res=await fetch('http://127.0.0.1:3098/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,body:await res.json(),headers:res.headers};}
const path=(ws,suffix='')=>'/workspaces/'+ws+suffix;
async function joinWorkspace(workspace,email,role){const invite=await api(path(workspace,'/invites'),{method:'POST',body:{email,role}});assert.equal(invite.status,201);const accepted=await api('/invites/'+invite.body.token+'/accept',{token:null,method:'POST',body:{name:email.split('@')[0],password:'a-strong-test-password'}});assert.equal(accepted.status,200,JSON.stringify(accepted.body));return accepted.body;}
before(start);after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
test('migrates legacy data once, backs up, and requires individual login',async()=>{
 assert.equal((await api('/login',{token:null,method:'POST',body:{password:'test-owner-password'}})).status,400);
 const login=await api('/login',{token:null,method:'POST',body:{email:'OWNER@folks.test',password:'test-owner-password'}});assert.equal(login.status,200);owner=login.body.token;wsA=login.body.workspaces[0].id;
 assert.ok(login.body.user.isOwner);assert.equal(login.body.workspaces[0].name,'Folks');
 assert.equal((await api(path(wsA,'/events'))).body[0].workspaceId,wsA);
 assert.equal((await api(path(wsA,'/hooks'))).body[0].secret,'preserve-this-secret');
 assert.equal((await api(path(wsA,'/deliveries'))).body[0].id,'legacy-job');
 const db=new DatabaseSync(dbPath);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);assert.equal(db.prepare('SELECT count(*) n FROM fired').get().n,1);assert.equal(db.prepare('SELECT workspace_id FROM jobs').get().workspace_id,wsA);assert.equal(JSON.parse(db.prepare('SELECT payload FROM jobs').get().payload).workspaceId,wsA);db.close();
 assert.equal(readdirSync(dir).filter(f=>f.startsWith('backup-before-workspaces')).length,1);
 assert.equal((await api('/events')).status,404);
 assert.equal((await api(path(wsA,'/events'),{token:'9999999999999.fake-legacy-signature'})).status,401);
});
test('owner creates isolated client and invites three roles plus another client',async()=>{
 const created=await api('/workspaces',{method:'POST',body:{name:'Cliente B'}});assert.equal(created.status,201);wsB=created.body.id;
 editor=await joinWorkspace(wsA,'editor@folks.test','editor');viewer=await joinWorkspace(wsA,'viewer@folks.test','viewer');admin=await joinWorkspace(wsA,'admin@folks.test','admin');userB=await joinWorkspace(wsB,'client@folks.test','admin');
 assert.equal(editor.workspaces.length,1);assert.equal(editor.workspaces[0].id,wsA);assert.equal(userB.workspaces.length,1);assert.equal(userB.workspaces[0].id,wsB);
 assert.equal((await api('/workspaces',{token:admin.token,method:'POST',body:{name:'Forbidden'}})).status,403);
 assert.equal((await api('/workspaces',{token:owner})).body.length,2);
});
test('rejects forged workspace and resource IDs for every tenant endpoint',async()=>{
 eventA=(await api(path(wsA,'/events'),{method:'POST',body:{...future,title:'Cliente A',workspaceId:wsB}})).body;
 eventB=(await api(path(wsB,'/events'),{token:userB.token,method:'POST',body:{...future,title:'Cliente B'}})).body;
 assert.equal(eventA.workspaceId,wsA);assert.equal(eventB.workspaceId,wsB);
 hookA=(await api(path(wsA,'/hooks'),{method:'POST',body:{name:'Hook A',url:'https://127.0.0.1',triggers:['event.created','event.started','event.reminder']}})).body;
 hookB=(await api(path(wsB,'/hooks'),{method:'POST',body:{name:'Hook B',url:'https://127.0.0.1',triggers:['event.created','event.started','event.reminder']}})).body;
 for(const suffix of ['/events','/hooks','/deliveries','/members'])assert.equal((await api(path(wsB,suffix),{token:admin.token})).status,404,suffix);
 for(const [suffix,method,body] of [[`/events/${eventB.id}`,'PUT',future],[`/events/${eventB.id}`,'DELETE'],[`/hooks/${hookB.id}`,'PUT',hookA],[`/hooks/${hookB.id}`,'DELETE'],[`/hooks/${hookB.id}/test`,'POST'],[`/members/${userB.user.id}`,'PATCH',{role:'viewer'}],[`/members/${userB.user.id}`,'DELETE']])assert.equal((await api(path(wsA,suffix),{token:admin.token,method,body})).status,404,suffix);
 const listA=(await api(path(wsA,'/events'),{token:viewer.token})).body;assert.ok(listA.every(e=>e.workspaceId===wsA));assert.ok(!listA.some(e=>e.id===eventB.id));
});
test('enforces viewer/editor/admin permissions and blocks escalation',async()=>{
 for(const method of ['POST','PUT','DELETE']){const suffix=method==='POST'?'/events':'/events/'+eventA.id;assert.equal((await api(path(wsA,suffix),{token:viewer.token,method,body:future})).status,403);}
 assert.equal((await api(path(wsA,'/events/'+eventA.id),{token:editor.token,method:'PUT',body:{...future,title:'Editado'}})).status,200);
 for(const token of [editor.token,viewer.token]){
  for(const suffix of ['/hooks','/deliveries','/members'])assert.equal((await api(path(wsA,suffix),{token})).status,403);
  assert.equal((await api(path(wsA,'/invites'),{token,method:'POST',body:{email:'x@folks.test',role:'admin'}})).status,403);
  assert.equal((await api(path(wsA),{token,method:'PATCH',body:{name:'Hacked'}})).status,403);
 }
 assert.equal((await api(path(wsA,'/invites'),{token:admin.token,method:'POST',body:{email:'x@folks.test',role:'owner'}})).status,400);
 assert.equal((await api(path(wsA,'/members/'+editor.user.id),{token:admin.token,method:'PATCH',body:{role:'owner'}})).status,400);
 const ownerId=(await api('/me')).body.user.id;
 assert.equal((await api(path(wsA,'/members/'+ownerId),{token:admin.token,method:'DELETE'})).status,403);
 assert.equal((await api(path(wsA,'/members/'+admin.user.id),{token:admin.token,method:'PATCH',body:{role:'viewer'}})).status,403);
});
test('invites are single-use, expiring, revocable, and preserve existing accounts',async()=>{
 const invite=(await api(path(wsB,'/invites'),{method:'POST',body:{email:viewer.user.email,role:'editor'}})).body;
 assert.equal((await api('/invites/'+invite.token,{token:null})).body.existingAccount,true);
 assert.equal((await api('/invites/'+invite.token+'/accept',{token:null,method:'POST',body:{password:'wrong-password'}})).status,400);
 const accepted=await api('/invites/'+invite.token+'/accept',{token:null,method:'POST',body:{password:'a-strong-test-password'}});assert.equal(accepted.status,200);assert.equal(accepted.body.user.id,viewer.user.id);assert.equal(accepted.body.workspaces.length,2);
 assert.equal((await api('/invites/'+invite.token+'/accept',{token:null,method:'POST',body:{password:'a-strong-test-password'}})).status,404);
 const revoked=(await api(path(wsA,'/invites'),{method:'POST',body:{email:'revoked@folks.test',role:'editor'}})).body;
 assert.equal((await api(path(wsB,'/invites/'+revoked.id),{token:userB.token,method:'DELETE'})).status,404);
 await api(path(wsA,'/invites/'+revoked.id),{method:'DELETE'});assert.equal((await api('/invites/'+revoked.token,{token:null})).status,404);
 const expired=(await api(path(wsA,'/invites'),{method:'POST',body:{email:'expired@folks.test',role:'viewer'}})).body;
 const db=new DatabaseSync(dbPath);db.prepare('UPDATE invites SET expires=0 WHERE id=?').run(expired.id);db.close();assert.equal((await api('/invites/'+expired.token,{token:null})).status,404);
});
test('role changes and removals apply to existing sessions and revoke pending invitations',async()=>{
 const pending=(await api(path(wsA,'/invites'),{token:admin.token,method:'POST',body:{email:'pending@folks.test',role:'admin'}})).body;
 await api(path(wsA,'/members/'+admin.user.id),{method:'PATCH',body:{role:'viewer'}});
 assert.equal((await api(path(wsA,'/hooks'),{token:admin.token})).status,403);
 assert.equal((await api('/invites/'+pending.token,{token:null})).status,404);
 await api(path(wsA,'/members/'+editor.user.id),{method:'DELETE'});
 assert.equal((await api(path(wsA,'/events'),{token:editor.token})).status,404);
 assert.equal((await api('/me',{token:editor.token})).body.workspaces.length,0);
});
test('webhook dispatch, scheduled jobs and history stay in their workspace',async()=>{
 const previousB=(await api(path(wsB,'/deliveries'))).body.length;
 await api(path(wsA,'/events'),{method:'POST',body:{...future,title:'Schedule A',start:new Date(Date.now()-1000).toISOString(),end:new Date(Date.now()+3600000).toISOString()}});
 await new Promise(r=>setTimeout(r,11000));
 const jobsA=(await api(path(wsA,'/deliveries'))).body;
 assert.ok(jobsA.some(j=>j.hook===hookA.id&&j.type==='event.started'));assert.ok(jobsA.some(j=>j.hook===hookA.id&&j.type==='event.reminder'));assert.ok(jobsA.every(j=>j.hook!==hookB.id));
 assert.equal((await api(path(wsB,'/deliveries'))).body.length,previousB);
 const db=new DatabaseSync(dbPath);for(const job of db.prepare('SELECT * FROM jobs').all()){assert.equal(JSON.parse(job.payload).workspaceId,job.workspace_id);}db.close();
});
test('workspace embed origins are validated and applied only to its document',async()=>{
 assert.equal((await api(path(wsA),{method:'PATCH',body:{origins:['http://crm.example.com']}})).status,400);
 assert.equal((await api(path(wsA),{method:'PATCH',body:{origins:['https://crm.example.com/path']}})).status,400);
 assert.equal((await api(path(wsA),{method:'PATCH',body:{origins:['https://crm.example.com']}})).status,200);
 const a=await fetch('http://127.0.0.1:3098/?embed=1&workspace='+wsA);assert.ok(a.headers.get('content-security-policy').includes('https://crm.example.com'));
 const b=await fetch('http://127.0.0.1:3098/?embed=1&workspace='+wsB);assert.ok(!b.headers.get('content-security-policy').includes('https://crm.example.com'));
});
test('sessions, tenant assignments and migration survive restart',async()=>{
 await stop();await start();assert.equal((await api('/me')).status,200);assert.equal((await api(path(wsB,'/events'),{token:userB.token})).body[0].id,eventB.id);assert.equal(readdirSync(dir).filter(f=>f.startsWith('backup-before-workspaces')).length,1);
 const db=new DatabaseSync(dbPath);assert.throws(()=>db.prepare('INSERT INTO events (id,body) VALUES (?,?)').run('unscoped','{}'));assert.throws(()=>db.prepare('UPDATE events SET workspace_id=? WHERE id=?').run(wsB,eventA.id));db.close();
});
test('password changes revoke all sessions and logout invalidates tokens',async()=>{
 assert.equal((await api('/me/password',{token:viewer.token,method:'POST',body:{currentPassword:'wrong',password:'another-strong-password'}})).status,400);
 assert.equal((await api('/me/password',{token:viewer.token,method:'POST',body:{currentPassword:'a-strong-test-password',password:'another-strong-password'}})).status,200);
 assert.equal((await api('/me',{token:viewer.token})).status,401);
 const login=await api('/login',{token:null,method:'POST',body:{email:viewer.user.email,password:'another-strong-password'}});assert.equal(login.status,200);
 await api('/logout',{token:login.body.token,method:'POST'});assert.equal((await api('/me',{token:login.body.token})).status,401);
});
