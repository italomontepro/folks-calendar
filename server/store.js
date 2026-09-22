import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { emailInput, hashPassword, newToken, passwordInput } from './security.js';

export async function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = resolve(dataDir, 'calendar.sqlite');
  const existed = existsSync(path);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  chmodSync(path, 0o600);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) {
    const email = emailInput(process.env.ADMIN_EMAIL || (process.env.NODE_ENV === 'production' ? '' : 'admin@folks.local'));
    if (process.env.NODE_ENV === 'production' && !process.env.APP_PASSWORD) throw new Error('Configure APP_PASSWORD para criar o administrador inicial.');
    const initialPassword = process.env.APP_PASSWORD || newToken();
    const passwordHash = await hashPassword(passwordInput(initialPassword));
    if (existed) {
      const target = resolve(dataDir, `backup-before-workspaces-${Date.now()}.sqlite`);
      await backup(db, target); chmodSync(target, 0o600);
      console.log('Backup anterior à migração:', target);
    }
    transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, hook TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER DEFAULT 0, next INTEGER NOT NULL, status TEXT DEFAULT 'pending', error TEXT, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS fired (key TEXT PRIMARY KEY);
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
        CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL COLLATE NOCASE, password_hash TEXT NOT NULL, is_owner INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE TABLE memberships (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), PRIMARY KEY(workspace_id,user_id));
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
        CREATE TABLE invites (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), invited_by TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
      `);
      const workspaceId = randomUUID(), userId = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, 'Folks', now);
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(userId, 'Administrador Folks', email, passwordHash, 1, now);
      db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(workspaceId, userId, 'admin');
      for (const table of ['events', 'hooks', 'jobs']) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)`);
        db.prepare(`UPDATE ${table} SET workspace_id=?`).run(workspaceId);
        db.exec(`CREATE INDEX ${table}_workspace ON ${table}(workspace_id)`);
        // SQLite ALTER cannot add a non-null FK to populated tables. Enforce it for all future writes.
        db.exec(`CREATE TRIGGER ${table}_require_workspace BEFORE INSERT ON ${table} WHEN NEW.workspace_id IS NULL BEGIN SELECT RAISE(ABORT,'workspace required'); END;
          CREATE TRIGGER ${table}_immutable_workspace BEFORE UPDATE OF workspace_id ON ${table} WHEN NEW.workspace_id IS NOT OLD.workspace_id BEGIN SELECT RAISE(ABORT,'workspace immutable'); END;`);
      }
      for (const row of db.prepare('SELECT id,payload FROM jobs').all()) {
        const payload = JSON.parse(row.payload);
        payload.workspaceId = workspaceId;
        if (payload.data && typeof payload.data === 'object') payload.data.workspaceId = workspaceId;
        db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
      }
      db.exec('CREATE INDEX sessions_expiry ON sessions(expires); CREATE INDEX invites_workspace ON invites(workspace_id); CREATE INDEX jobs_due ON jobs(status,next); PRAGMA user_version=2;');
    });
    if (!process.env.APP_PASSWORD) {
      const credentials = resolve(dataDir, 'bootstrap-admin.txt');
      writeFileSync(credentials, `Login: ${email}\nSenha: ${initialPassword}\n`, { mode: 0o600 });
      console.log('Acesso inicial de desenvolvimento salvo em:', credentials);
    }
  }
  if (version < 3) {
    if (existed) {
      const target = resolve(dataDir, `backup-before-helena-${Date.now()}.sqlite`);
      await backup(db, target); chmodSync(target, 0o600);
    }
    transaction(() => {
      db.exec(`CREATE TABLE integrations (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), token TEXT NOT NULL, revision TEXT NOT NULL);
        ALTER TABLE jobs ADD COLUMN provider_id TEXT;
        ALTER TABLE jobs ADD COLUMN provider_status TEXT;
        ALTER TABLE jobs ADD COLUMN integration_revision TEXT;
        PRAGMA user_version=3;`);
    });
  }
  if (version < 4) {
    transaction(() => {
      db.exec('ALTER TABLE integrations ADD COLUMN webhook_secret TEXT; ALTER TABLE integrations ADD COLUMN reschedule_department_id TEXT; PRAGMA user_version=4;');
      const secret = () => randomBytes(32).toString('base64url');
      for (const row of db.prepare('SELECT workspace_id FROM integrations').all()) {
        db.prepare('UPDATE integrations SET webhook_secret=?,reschedule_department_id=? WHERE workspace_id=?')
          .run(secret(), '1f08f5c8-c4ae-4730-b820-871e7d8af275', row.workspace_id);
      }
    });
  }
  if (version < 5) {
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS google_integrations (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), refresh_token TEXT NOT NULL, calendar_id TEXT NOT NULL DEFAULT 'primary', account_email TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS google_oauth_states (state TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
        PRAGMA user_version=4;`);
    });
  }
  const parseRow = row => row ? { ...JSON.parse(row.body), workspaceId: row.workspace_id } : null;
  const all = (table, workspaceId) => {
    if (!workspaceId) throw new Error('Workspace obrigatório');
    return db.prepare(`SELECT body,workspace_id FROM ${table} WHERE workspace_id=?`).all(workspaceId).map(parseRow);
  };
  const get = (table, id, workspaceId) => db.prepare(`SELECT body,workspace_id FROM ${table} WHERE id=? AND workspace_id=?`).get(id, workspaceId);
  const put = (table, value, workspaceId) => {
    const body = JSON.stringify({ ...value, workspaceId });
    db.prepare(`INSERT INTO ${table} (id,body,workspace_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE ${table}.workspace_id=excluded.workspace_id`).run(value.id, body, workspaceId);
  };
  return { db, transaction, all, get: (table,id,workspaceId) => parseRow(get(table,id,workspaceId)), put, parseRow };
}
