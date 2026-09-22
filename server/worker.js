import { randomUUID } from 'node:crypto';
import { deliver } from './delivery.js';
import { getIntegration, templateBody, helenaRequest } from './helena.js';
export function createWorker(store, providers = {}) {
  const { db, all, get, transaction, parseRow } = store;
  const sendHelena=providers.helena || helenaRequest, sendWebhook=providers.webhook || deliver;
  // The provider does not document idempotency. Never blindly repeat an interrupted POST.
  db.prepare("UPDATE jobs SET status='unknown',error='Envio interrompido. Confira o atendimento antes de reenviar.' WHERE status='sending'").run();
  function enqueue(type, event, workspaceId, onlyHook, webhookOnly=false) {
    for (const hook of all('hooks', workspaceId).filter(h => h.enabled && (!webhookOnly || h.kind!=='helena') && (onlyHook ? h.id === onlyHook : h.triggers.includes(type)))) {
      if(hook.kind==='helena' && (event.messagesEnabled===false || (hook.categories?.length && !hook.categories.includes(event.category)) || (hook.recipient==='assignee' && (!event.assigneeName || !event.assigneePhone))))continue;
      const id = randomUUID(), created = new Date().toISOString();
      const payload = { id, type, workspaceId, createdAt: created, source: 'folks-calendar', data: { ...event, workspaceId }, ...(hook.kind==='helena'?{automation:hook}:{}) };
      db.prepare('INSERT INTO jobs (id,hook,payload,next,created,workspace_id) VALUES (?,?,?,?,?,?)').run(id, hook.id, JSON.stringify(payload), Date.now(), created, workspaceId);
    }
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = Date.now();
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(now);
      for (const row of db.prepare('SELECT body,workspace_id FROM events').all()) {
        const event = parseRow(row), start = Date.parse(event.start);
        for (const [type,due] of [['event.started',start],['event.reminder',start-event.reminder*60000]]) {
          if (type === 'event.reminder' && !event.reminder) continue;
          if (due > now || start + 24*3600000 < now) continue;
          const key = `${event.id}:${event.revision}:${type}`;
          transaction(() => {
            const inserted = db.prepare('INSERT OR IGNORE INTO fired (key) VALUES (?)').run(key);
            if (inserted.changes) enqueue(type, event, event.workspaceId,undefined,true);
          });
        }
        for(const hook of all('hooks',event.workspaceId).filter(h=>h.kind==='helena' && h.enabled)) {
          for(const type of hook.triggers.filter(t=>['event.started','event.reminder'].includes(t))) {
            const due=start-(type==='event.reminder'?hook.reminderMinutes*60000:0);
            // Do not send old appointments or replay reminders missed before activation.
            if(due>now || now-due>3600000 || due<Date.parse(hook.createdAt) || (type==='event.reminder' && start<=now))continue;
            const key=`helena:${hook.id}:${event.id}:${event.revision}:${type}`;
            transaction(()=>{if(db.prepare('INSERT OR IGNORE INTO fired (key) VALUES (?)').run(key).changes)enqueue(type,event,event.workspaceId,hook.id);});
          }
        }
      }
      for (const job of db.prepare("SELECT * FROM jobs WHERE status='pending' AND next<=? ORDER BY next LIMIT 10").all(now)) {
        const currentHook = get('hooks', job.hook, job.workspace_id), payload=JSON.parse(job.payload);
        if (!currentHook?.enabled) { db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id); continue; }
        const hook=payload.automation || currentHook;
        if(hook.kind==='helena') {
          const config=getIntegration(db,job.workspace_id),event=get('events',payload.data.id,job.workspace_id);
          const scheduled=['event.reminder','event.started'].includes(payload.type);
          if(!config || config.revision!==hook.integrationRevision || currentHook.revision!==hook.revision || (payload.type!=='event.deleted' && (!event || event.messagesEnabled===false)) || (scheduled && (event?.revision!==payload.data.revision || (payload.type==='event.reminder' && Date.parse(event.start)<=now)))) {
            db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);continue;
          }
          try {
            const body=templateBody(hook,scheduled?event:payload.data,job.id);
            db.prepare("UPDATE jobs SET status='sending',attempts=attempts+1,integration_revision=? WHERE id=?").run(config.revision,job.id);
            const result=await sendHelena(config.token,'send/template',body);
            if(!result?.id)throw Object.assign(new Error('O HELENA não retornou o ID. Confira o atendimento antes de reenviar.'),{ambiguous:true});
            const status=result.status==='FAILED'?'failed':['DELIVERED','READ'].includes(result.status)?'delivered':'accepted';
            db.prepare('UPDATE jobs SET status=?,provider_id=?,provider_status=?,error=? WHERE id=?').run(status,result.id,result.status || 'PROCESSING',status==='failed'?'O HELENA informou falha no envio. Consulte o atendimento.':null,job.id);
          } catch(error) {
            const count=job.attempts+1;
            db.prepare('UPDATE jobs SET attempts=?,status=?,error=?,next=? WHERE id=?').run(count,error.ambiguous?'unknown':error.retryable && count<5?'pending':'failed',error.message,Date.now()+Math.min(3600,30*2**(count-1))*1000,job.id);
          }
          continue;
        }
        try {
          await sendWebhook(hook.url, payload, hook.secret);
          db.prepare("UPDATE jobs SET status='delivered',attempts=attempts+1,error=NULL WHERE id=?").run(job.id);
        } catch (error) {
          const count = job.attempts + 1;
          db.prepare("UPDATE jobs SET attempts=?,status=?,error=?,next=? WHERE id=? AND status='pending'").run(count, count >= 5 ? 'failed' : 'pending', error.message, Date.now()+Math.min(3600,30*2**(count-1))*1000, job.id);
        }
      }
    } finally { running = false; }
  }
  return { enqueue, tick };
}
