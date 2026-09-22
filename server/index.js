import express from 'express';
import { resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { eventInput, hookInput } from './validation.js';
import { installHelena, validateHelenaHook } from './helena.js';
import { fail } from './security.js';
import { openStore } from './store.js';
import { installIdentity } from './identity.js';
import { createWorker } from './worker.js';
import { installGoogle, createGoogleEvent } from './google.js';

const store = await openStore(resolve(process.env.DATA_DIR || './data'));
const { db, all, get, put, transaction } = store;
const { enqueue, tick } = createWorker(store);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY_HOPS) app.set('trust proxy',Number(process.env.TRUST_PROXY_HOPS));
app.use(express.json({limit:'64kb'}));
app.use((req,res,next) => {
  const requestedWorkspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  const workspace = db.prepare('SELECT origins FROM workspaces WHERE id=?').get(requestedWorkspace);
  const origins = workspace ? JSON.parse(workspace.origins).join(' ') : '';
  res.setHeader('Content-Security-Policy',`frame-ancestors ${process.env.FRAME_ANCESTORS || "'self'"} ${origins}`.trim());
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if (req.path.startsWith('/api') || req.query.workspace) res.setHeader('Cache-Control','no-store');
  next();
});
const { requireRoles, admin } = await installIdentity(app,store);
const edit = requireRoles('owner','admin','editor');
const base = '/api/workspaces/:workspaceId';
installHelena(app,store,base,admin);
installGoogle(app,store,base,admin);
function validateAutomationFields(event, workspaceId) {
  const rules = all('hooks', workspaceId).filter(h => h.kind === 'helena' && h.enabled);
  if (rules.some(h => h.recipient !== 'assignee') && (!event.contactName || !event.phone)) fail(400, 'Para enviar ao cliente, informe o nome e o WhatsApp com DDI (ex.: 5592984532273).');
  if (rules.some(h => h.recipient === 'assignee') && (!event.assigneeName || !event.assigneePhone)) fail(400, 'Para notificar o responsável, informe nome e WhatsApp do responsável com DDI.');
}
app.get(base+'/events',(req,res) => res.json(all('events',req.workspaceId)));
app.post(base+'/events',edit,async(req,res) => {
  const event = {...eventInput(req.body),id:randomUUID(),revision:randomUUID(),createdAt:new Date().toISOString(),createdBy:req.user.id,workspaceId:req.workspaceId};
  validateAutomationFields(event, req.workspaceId);
  transaction(() => { put('events',event,req.workspaceId); enqueue('event.created',event,req.workspaceId); });
  try { const remote = await createGoogleEvent(db, req.workspaceId, event); if (remote?.id) { event.googleEventId=remote.id; event.googleSyncStatus='synced'; put('events',event,req.workspaceId); } }
  catch (error) { event.googleSyncStatus='error'; event.googleSyncError=error.message; put('events',event,req.workspaceId); }
  res.status(201).json(event);
});
app.put(base+'/events/:id',edit,(req,res) => {
  const old = get('events',req.params.id,req.workspaceId);
  if (!old) fail(404,'Evento não encontrado.');
  const event = {...old,...eventInput(req.body),updatedAt:new Date().toISOString(),updatedBy:req.user.id};
  validateAutomationFields(event, req.workspaceId);
  if (event.start !== old.start || event.reminder !== old.reminder) event.revision = randomUUID();
  transaction(() => { put('events',event,req.workspaceId); enqueue('event.updated',event,req.workspaceId); });
  res.json(event);
});
app.delete(base+'/events/:id',edit,(req,res) => {
  const event = get('events',req.params.id,req.workspaceId);
  if (!event) fail(404,'Evento não encontrado.');
  transaction(() => { db.prepare('DELETE FROM events WHERE id=? AND workspace_id=?').run(event.id,req.workspaceId); enqueue('event.deleted',event,req.workspaceId); });
  res.json({ok:true});
});
app.get(base+'/hooks',admin,(req,res) => res.json(all('hooks',req.workspaceId)));
app.post(base+'/hooks',admin,async(req,res) => {
  const hook = {...await validateHelenaHook(db,req.workspaceId,hookInput(req.body)),createdAt:new Date().toISOString(),revision:randomUUID(),id:randomUUID(),secret:randomBytes(32).toString('hex'),workspaceId:req.workspaceId};
  put('hooks',hook,req.workspaceId);res.status(201).json(hook);
});
app.put(base+'/hooks/:id',admin,async(req,res) => {
  const old = get('hooks',req.params.id,req.workspaceId);
  if (!old) fail(404,'Automação não encontrada.');
  const input=hookInput(req.body);
  const hook = {...old,...(old.kind==='helena' && input.kind==='helena' && !input.enabled ? input : await validateHelenaHook(db,req.workspaceId,input)),revision:randomUUID()};
  if (old.kind==='helena' && !old.enabled && hook.enabled) hook.createdAt=new Date().toISOString();
  transaction(() => {
    put('hooks',hook,req.workspaceId);
    if (!hook.enabled || hook.kind==='helena') db.prepare("UPDATE jobs SET status='cancelled' WHERE hook=? AND workspace_id=? AND status='pending'").run(hook.id,req.workspaceId);
  });
  res.json(hook);
});
app.delete(base+'/hooks/:id',admin,(req,res) => {
  if (!get('hooks',req.params.id,req.workspaceId)) fail(404,'Automação não encontrada.');
  transaction(() => {
    db.prepare('DELETE FROM hooks WHERE id=? AND workspace_id=?').run(req.params.id,req.workspaceId);
    db.prepare("UPDATE jobs SET status='cancelled' WHERE hook=? AND workspace_id=? AND status='pending'").run(req.params.id,req.workspaceId);
  });
  res.json({ok:true});
});
app.post(base+'/hooks/:id/test',admin,(req,res) => {
  const hook = get('hooks',req.params.id,req.workspaceId);
  if (!hook) fail(404,'Automação não encontrada.');
  if (hook.kind==='helena') fail(400,'Para conferir a conexão, carregue os modelos. Testes de webhook não enviam mensagens.');
  if (!hook.enabled) fail(400,'Ative a automação antes de testar.');
  enqueue('webhook.test',{message:'Olá do Folks Calendar!'},req.workspaceId,hook.id);res.json({ok:true});
});
app.get(base+'/deliveries',admin,(req,res) => res.json(db.prepare('SELECT id,hook,attempts,status,error,created,payload,provider_id,provider_status FROM jobs WHERE workspace_id=? ORDER BY created DESC LIMIT 100').all(req.workspaceId).map(j=>({...j,type:JSON.parse(j.payload).type,payload:undefined}))));
const timer = setInterval(() => tick().catch(console.error),5000);timer.unref();
app.use('/api',(_req,res) => res.status(404).json({error:'Rota não encontrada.'}));
app.use(express.static(resolve('dist')));
app.get('/{*path}',(_req,res) => res.sendFile(resolve('dist/index.html')));
app.use((err,_req,res,_next) => {
  const status = err.status || (err.code?.startsWith('ERR_SQLITE') ? 500 : 400);
  if (status >= 500) console.error(err);
  res.status(status).json({error:status>=500?'Não foi possível concluir a operação.':err.message||'Requisição inválida.'});
});
const server = app.listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log(`Folks Calendar: http://localhost:${process.env.PORT||3001}`));
process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>process.exit(0));});
