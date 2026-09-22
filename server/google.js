import { randomBytes } from 'node:crypto';
import { emailList } from './validation.js';

const scope = 'openid email https://www.googleapis.com/auth/calendar.events';
const cfg = () => ({ id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET });
const redirect = () => process.env.GOOGLE_REDIRECT_URI || `${process.env.PUBLIC_URL || 'http://localhost:3001'}/api/google/callback`;
async function jsonFetch(url, options) {
  const r = await fetch(url, options); const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error_description || body.error?.message || 'Falha na integração com o Google.');
  return body;
}
async function accessToken(integration) {
  const c = cfg(); if (!c.id || !c.secret) throw new Error('Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no painel.');
  const body = new URLSearchParams({ client_id:c.id, client_secret:c.secret, refresh_token:integration.refresh_token, grant_type:'refresh_token' });
  return (await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body})).access_token;
}
function eventBody(event) {
  const body = { summary:event.title, description:event.description || '', location:event.location || '' };
  if (event.allDay) { body.start={date:event.start.slice(0,10)}; body.end={date:event.end.slice(0,10)}; }
  else { body.start={dateTime:event.start}; body.end={dateTime:event.end}; }
  body.attendees = emailList(event.email).map(email => ({ email }));
  return body;
}
async function calendarRequest(db, workspaceId, path, options) {
  const integration = db.prepare('SELECT * FROM google_integrations WHERE workspace_id=?').get(workspaceId);
  if (!integration) return null;
  const token = await accessToken(integration);
  return jsonFetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.calendar_id)}/events${path}`,
    { ...options, headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'} });
}
export const createGoogleEvent = (db, workspaceId, event) =>
  calendarRequest(db, workspaceId, '?sendUpdates=all', { method:'POST', body:JSON.stringify(eventBody(event)) });
export const updateGoogleEvent = (db, workspaceId, event) =>
  calendarRequest(db, workspaceId, `/${encodeURIComponent(event.googleEventId)}?sendUpdates=all`, { method:'PATCH', body:JSON.stringify(eventBody(event)) });
export const deleteGoogleEvent = (db, workspaceId, event) =>
  calendarRequest(db, workspaceId, `/${encodeURIComponent(event.googleEventId)}?sendUpdates=all`, { method:'DELETE' });
export function installGoogle(app, store, base, admin) {
  const { db } = store;
  app.get(base+'/google', admin, (req,res) => {
    const row = db.prepare('SELECT account_email,calendar_id,created_at,updated_at FROM google_integrations WHERE workspace_id=?').get(req.workspaceId);
    res.json({ connected:!!row, ...row });
  });
  app.get(base+'/google/connect', admin, (req,res) => {
    const c = cfg(); if (!c.id || !c.secret) return res.status(503).json({error:'Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no painel do servidor.'});
    const state = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO google_oauth_states (state,workspace_id,user_id,expires) VALUES (?,?,?,?)').run(state,req.workspaceId,req.user.id,Date.now()+10*60*1000);
    const params = new URLSearchParams({client_id:c.id,redirect_uri:redirect(),response_type:'code',access_type:'offline',prompt:'consent',scope,state});
    res.json({url:'https://accounts.google.com/o/oauth2/v2/auth?'+params});
  });
  app.get('/api/google/callback', async (req,res,next) => {
    try {
      const row = db.prepare('SELECT * FROM google_oauth_states WHERE state=? AND expires>?').get(req.query.state,Date.now());
      if (!row || !req.query.code) throw new Error('Autorização Google inválida ou expirada.');
      const c = cfg(); const tokens = await jsonFetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:req.query.code,client_id:c.id,client_secret:c.secret,redirect_uri:redirect(),grant_type:'authorization_code'})});
      if (!tokens.refresh_token) throw new Error('O Google não retornou refresh token. Tente conectar novamente.');
      const profile = await jsonFetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{Authorization:`Bearer ${tokens.access_token}`}});
      const now = new Date().toISOString();
      db.prepare('INSERT INTO google_integrations (workspace_id,refresh_token,calendar_id,account_email,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET refresh_token=excluded.refresh_token,account_email=excluded.account_email,updated_at=excluded.updated_at').run(row.workspace_id,tokens.refresh_token,'primary',profile.email||null,now,now);
      db.prepare('DELETE FROM google_oauth_states WHERE state=?').run(row.state);
      res.redirect('/?workspace='+encodeURIComponent(row.workspace_id)+'&google=connected');
    } catch(e) { next(e); }
  });
  app.delete(base+'/google', admin, (req,res) => { db.prepare('DELETE FROM google_integrations WHERE workspace_id=?').run(req.workspaceId); res.json({ok:true}); });
}
