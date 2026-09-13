import { randomUUID } from 'node:crypto';
import { deliver } from './delivery.js';
export function createWorker(store) {
  const { db, all, get, transaction, parseRow } = store;
  function enqueue(type, event, workspaceId, onlyHook) {
    for (const hook of all('hooks', workspaceId).filter(h => h.enabled && (onlyHook ? h.id === onlyHook : h.triggers.includes(type)))) {
      const id = randomUUID(), created = new Date().toISOString();
      const payload = { id, type, workspaceId, createdAt: created, source: 'folks-calendar', data: { ...event, workspaceId } };
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
          // Keep legacy keys so migration does not resend already-fired reminders.
          const key = `${event.id}:${event.revision}:${type}`;
          transaction(() => {
            const inserted = db.prepare('INSERT OR IGNORE INTO fired (key) VALUES (?)').run(key);
            if (inserted.changes) enqueue(type, event, event.workspaceId);
          });
        }
      }
      for (const job of db.prepare("SELECT * FROM jobs WHERE status='pending' AND next<=? ORDER BY next LIMIT 10").all(now)) {
        const hook = get('hooks', job.hook, job.workspace_id);
        if (!hook?.enabled) { db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id); continue; }
        try {
          await deliver(hook.url, JSON.parse(job.payload), hook.secret);
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
