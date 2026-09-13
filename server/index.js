import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { eventInput, hookInput } from './validation.js';
import { deliver } from './delivery.js';
const production = process.env.NODE_ENV === 'production';
const password = process.env.APP_PASSWORD;
if (production && (!password || !process.env.SESSION_SECRET)) throw new Error('Configure APP_PASSWORD e SESSION_SECRET antes de publicar.');
const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
const dataDir = resolve(process.env.DATA_DIR || './data'); mkdirSync(dataDir,{recursive:true});
const db = new DatabaseSync(resolve(dataDir,'calendar.sqlite')); db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hook TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, next INTEGER NOT NULL, status TEXT DEFAULT 'pending', error TEXT, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fired (key TEXT PRIMARY KEY);
`);
const app = express(); app.disable('x-powered-by'); app.use(express.json({limit:'64kb'}));
app.use((req,res,next)=>{res.setHeader('Content-Security-Policy',`frame-ancestors ${process.env.FRAME_ANCESTORS || "'self'"}`);res.setHeader('X-Content-Type-Options','nosniff');next();});
const all = table=>db.prepare(`SELECT body FROM ${table}`).all().map(row=>JSON.parse(row.body));
const get = (table,id)=>{const row=db.prepare(`SELECT body FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(row.body):null;};
const put = (table,value)=>db.prepare(`INSERT OR REPLACE INTO ${table} (id,body) VALUES (?,?)`).run(value.id,JSON.stringify(value));
const sign = value=>createHmac('sha256',secret).update(value).digest('hex');
const equal = (a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const attempts = new Map();
app.get('/api/auth',(_req,res)=>res.json({required:!!password}));
app.post('/api/login',(req,res)=>{
 const key=req.ip, previous=attempts.get(key), record=previous && previous.until>Date.now()?previous:{count:0,until:Date.now()+900000};
 if(record.count>=10)return res.status(429).json({error:'Muitas tentativas. Aguarde 15 minutos.'});
 if(password&&!equal(String(req.body.password||''),password)){record.count++;attempts.set(key,record);return res.status(401).json({error:'Senha incorreta.'});}
 attempts.delete(key);const value=String(Date.now()+12*60*60*1000);res.json({token:`${value}.${sign(value)}`});
});
app.use('/api',(req,res,next)=>{
 res.setHeader('Cache-Control','no-store');
 if(!password)return next();
 const [expires,signature='']=(req.headers.authorization||'').replace(/^Bearer /,'').split('.');
 if(!expires||Number(expires)<Date.now()||!equal(signature,sign(expires)))return res.status(401).json({error:'Entre para acessar sua agenda.'});next();
});
function enqueue(type,event,onlyHook) {
 for(const hook of all('hooks').filter(h=>h.enabled&&(onlyHook?h.id===onlyHook:h.triggers.includes(type)))){
  const id=randomUUID(),created=new Date().toISOString();
  const payload={id,type,createdAt:created,source:'folks-calendar',data:event};
  db.prepare('INSERT INTO jobs (id,hook,payload,next,created) VALUES (?,?,?,?,?)').run(id,hook.id,JSON.stringify(payload),Date.now(),created);
 }
}
function transaction(fn){db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
app.get('/api/events',(_req,res)=>res.json(all('events')));
app.post('/api/events',(req,res)=>{const event={...eventInput(req.body),id:randomUUID(),revision:randomUUID(),createdAt:new Date().toISOString()};transaction(()=>{put('events',event);enqueue('event.created',event);});res.status(201).json(event);});
app.put('/api/events/:id',(req,res)=>{const old=get('events',req.params.id);if(!old)return res.status(404).json({error:'Evento não encontrado.'});const event={...old,...eventInput(req.body),updatedAt:new Date().toISOString()};if(event.start!==old.start||event.reminder!==old.reminder)event.revision=randomUUID();transaction(()=>{put('events',event);enqueue('event.updated',event);});res.json(event);});
app.delete('/api/events/:id',(req,res)=>{const event=get('events',req.params.id);if(!event)return res.status(404).json({error:'Evento não encontrado.'});transaction(()=>{db.prepare('DELETE FROM events WHERE id=?').run(event.id);enqueue('event.deleted',event);});res.json({ok:true});});
app.get('/api/hooks',(_req,res)=>res.json(all('hooks')));
app.post('/api/hooks',(req,res)=>{const hook={...hookInput(req.body),id:randomUUID(),secret:randomBytes(32).toString('hex')};put('hooks',hook);res.status(201).json(hook);});
app.put('/api/hooks/:id',(req,res)=>{const old=get('hooks',req.params.id);if(!old)return res.status(404).json({error:'Automação não encontrada.'});const hook={...old,...hookInput(req.body)};put('hooks',hook);res.json(hook);});
app.delete('/api/hooks/:id',(req,res)=>{db.prepare('DELETE FROM hooks WHERE id=?').run(req.params.id);db.prepare("UPDATE jobs SET status='cancelled' WHERE hook=? AND status='pending'").run(req.params.id);res.json({ok:true});});
app.post('/api/hooks/:id/test',(req,res)=>{const hook=get('hooks',req.params.id);if(!hook?.enabled)return res.status(400).json({error:'Ative a automação antes de testar.'});enqueue('webhook.test',{message:'Olá do Folks Calendar!'},hook.id);res.json({ok:true});});
app.get('/api/deliveries',(_req,res)=>res.json(db.prepare('SELECT id,hook,attempts,status,error,created,payload FROM jobs ORDER BY created DESC LIMIT 100').all().map(j=>({...j,type:JSON.parse(j.payload).type,payload:undefined}))));
let running=false;
async function tick(){if(running)return;running=true;try{
 const now=Date.now();
 for(const event of all('events')){
  const start=Date.parse(event.start);
  for(const [type,due] of [['event.started',start],['event.reminder',start-event.reminder*60000]]){
   if(type==='event.reminder'&&!event.reminder)continue;
   if(due>now||start+24*3600000<now)continue;
   const key=`${event.id}:${event.revision}:${type}`;
   transaction(()=>{const inserted=db.prepare('INSERT OR IGNORE INTO fired (key) VALUES (?)').run(key);if(inserted.changes)enqueue(type,event);});
  }
 }
 for(const job of db.prepare("SELECT * FROM jobs WHERE status='pending' AND next<=? ORDER BY next LIMIT 10").all(now)){
  const hook=get('hooks',job.hook);
  if(!hook?.enabled){db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);continue;}
  try{await deliver(hook.url,JSON.parse(job.payload),hook.secret);db.prepare("UPDATE jobs SET status='delivered',attempts=attempts+1,error=NULL WHERE id=?").run(job.id);}
  catch(error){const n=job.attempts+1;db.prepare('UPDATE jobs SET attempts=?,status=?,error=?,next=? WHERE id=?').run(n,n>=5?'failed':'pending',error.message,Date.now()+Math.min(3600,30*2**(n-1))*1000,job.id);}
 }
 }finally{running=false;}}
const timer=setInterval(()=>tick().catch(console.error),5000);timer.unref();
app.use('/api',(_req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
app.use(express.static(resolve('dist')));app.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/index.html')));
app.use((err,_req,res,_next)=>res.status(400).json({error:err.message||'Não foi possível concluir a operação.'}));
const server=app.listen(Number(process.env.PORT||3001),'0.0.0.0',()=>console.log(`Folks Calendar: http://localhost:${process.env.PORT||3001}`));
process.on('SIGTERM',()=>{clearInterval(timer);server.close(()=>process.exit(0));});
