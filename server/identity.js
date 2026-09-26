import { randomUUID } from 'node:crypto';
import { digest, newToken, fail, emailInput, nameInput, passwordInput, hashPassword, verifyPassword, roleInput, originsInput } from './security.js';

export async function installIdentity(app, store) {
  const { db, transaction } = store;
  const publicUser = user => ({ id: user.id, name: user.name, email: user.email, isOwner: !!user.is_owner });
  const workspaceView = row => ({ id: row.id, name: row.name, origins: JSON.parse(row.origins), createdAt: row.created_at, role: row.role });
  function workspaces(user) {
    const rows = user.is_owner
      ? db.prepare("SELECT *, 'owner' AS role FROM workspaces ORDER BY created_at,id").all()
      : db.prepare('SELECT w.*,m.role FROM workspaces w JOIN memberships m ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at,w.id').all(user.id);
    return rows.map(workspaceView);
  }
  function sessionUser(req) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!/^[\w-]{43}$/.test(token)) return null;
    return db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?').get(digest(token), Date.now());
  }
  function requireUser(req,_res,next) {
    // HELENA calls this endpoint server-to-server and authenticates with the
    // workspace-specific secret in the URL instead of a calendar session.
    if (req.path.startsWith('/helena/webhook/')) return next();
    // O Google devolve o usuário aqui por redirecionamento de navegador, sem
    // header de sessão; quem autentica a requisição é o parâmetro state, que o
    // handler confere contra google_oauth_states antes de gravar qualquer token.
    if (req.path === '/google/callback') return next();
    req.user = sessionUser(req); if (!req.user) fail(401, 'Entre com seu e-mail e senha.'); next();
  }
  function issueSession(user) {
    const token = newToken();
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), user.id, Date.now()+12*3600000);
    return { token, user: publicUser(user), workspaces: workspaces(user) };
  }
  function workspaceRole(user, id) {
    if (user.is_owner) return db.prepare('SELECT id FROM workspaces WHERE id=?').get(id) ? 'owner' : null;
    return db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(id,user.id)?.role;
  }
  function requireWorkspace(req,_res,next) {
    const role = workspaceRole(req.user, req.params.workspaceId);
    if (!role) fail(404, 'Workspace não encontrado ou acesso removido.');
    req.workspaceId = req.params.workspaceId; req.role = role; next();
  }
  const requireRoles = (...roles) => (req,_res,next) => { if (!roles.includes(req.role)) fail(403, 'Seu perfil não permite esta ação.'); next(); };
  const admin = requireRoles('owner', 'admin');
  const limits = new Map();
  function rateLimit(req,_res,next) {
    const now = Date.now();
    for (const [key,value] of limits) if (value.until <= now) limits.delete(key);
    if (limits.size >= 10000) fail(429, 'Muitas tentativas. Aguarde alguns minutos.');
    const key = `${req.ip}:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0,254) : req.path.slice(0,120)}`;
    const entry = limits.get(key) || { count: 0, until: now+900000 };
    limits.set(key, entry); entry.count++;
    if (entry.count > 15) fail(429, 'Muitas tentativas. Aguarde 15 minutos.');
    next();
  }
  const dummyHash = await hashPassword(newToken());
  app.get('/api/auth',(_req,res) => res.json({ required: true, individualAccounts: true }));
  app.post('/api/login',rateLimit,async(req,res) => {
    const email = emailInput(req.body?.email);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const valid = await verifyPassword(req.body?.password, user?.password_hash || dummyHash);
    if (!user || !valid || db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id)?.password_hash !== user.password_hash) fail(401, 'E-mail ou senha incorretos.');
    res.json(issueSession(user));
  });
  function validInvite(token) {
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) fail(404, 'Convite inválido, expirado ou revogado.');
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires>?').get(digest(token),Date.now());
    const issuer = invite && db.prepare('SELECT * FROM users WHERE id=?').get(invite.invited_by);
    if (!invite || !issuer || !['owner','admin'].includes(workspaceRole(issuer,invite.workspace_id))) fail(404, 'Convite inválido, expirado ou revogado.');
    return invite;
  }
  app.get('/api/invites/:token', (req,res) => {
    const invite = validInvite(req.params.token);
    const workspace = db.prepare('SELECT name FROM workspaces WHERE id=?').get(invite.workspace_id);
    const exists = !!db.prepare('SELECT id FROM users WHERE email=?').get(invite.email);
    res.json({ email: invite.email, workspaceName: workspace.name, workspaceId: invite.workspace_id, role: invite.role, existingAccount: exists, expires: invite.expires });
  });
  app.post('/api/invites/:token/accept',rateLimit,async(req,res) => {
    const invite = validInvite(req.params.token);
    const existing = db.prepare('SELECT * FROM users WHERE email=?').get(invite.email);
    let passwordHash, name;
    if (existing) {
      if (!await verifyPassword(req.body?.password,existing.password_hash)) fail(400, 'Informe a senha da sua conta existente.');
    } else {
      name = nameInput(req.body?.name);
      passwordHash = await hashPassword(passwordInput(req.body?.password));
    }
    const response = transaction(() => {
      const fresh = validInvite(req.params.token);
      const current = db.prepare('SELECT * FROM users WHERE email=?').get(fresh.email);
      if ((current?.id !== existing?.id) || current?.password_hash !== existing?.password_hash) fail(409, 'A conta foi alterada. Reabra o convite e tente novamente.');
      const userId = existing?.id || randomUUID();
      if (!existing) db.prepare('INSERT INTO users VALUES (?,?,?,?,0,?)').run(userId,name,fresh.email,passwordHash,new Date().toISOString());
      // An invite cannot overwrite permissions changed separately by an administrator.
      db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?,?)').run(fresh.workspace_id,userId,fresh.role);
      db.prepare('UPDATE invites SET used_at=? WHERE id=?').run(new Date().toISOString(),fresh.id);
      return { ...issueSession(db.prepare('SELECT * FROM users WHERE id=?').get(userId)), workspaceId: fresh.workspace_id };
    });
    res.json(response);
  });
  app.use('/api',requireUser);
  app.get('/api/me',(req,res) => res.json({ user: publicUser(req.user), workspaces: workspaces(req.user) }));
  app.post('/api/logout',(req,res) => { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest((req.headers.authorization||'').replace(/^Bearer /,''))); res.json({ok:true}); });
  app.post('/api/me/password',rateLimit,async(req,res) => {
    if (!await verifyPassword(req.body?.currentPassword,req.user.password_hash)) fail(400, 'A senha atual está incorreta.');
    const hash = await hashPassword(passwordInput(req.body?.password));
    transaction(() => {
      if (db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)?.password_hash !== req.user.password_hash) fail(409, 'A senha foi alterada. Entre novamente.');
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    });
    res.json({ok:true});
  });
  app.get('/api/workspaces',(req,res) => res.json(workspaces(req.user)));
  app.post('/api/workspaces',(req,res) => {
    if (!req.user.is_owner) fail(403, 'Somente a administração FolkSales pode criar workspaces.');
    const id = randomUUID(), name = nameInput(req.body?.name), created = new Date().toISOString();
    const origins = originsInput(req.body?.origins);
    transaction(() => {
      db.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(id,name,JSON.stringify(origins),created);
      db.prepare('INSERT INTO memberships VALUES (?,?,?)').run(id,req.user.id,'admin');
    });
    res.status(201).json({id,name,origins,createdAt:created,role:'owner'});
  });
  app.use('/api/workspaces/:workspaceId', requireWorkspace);
  app.patch('/api/workspaces/:workspaceId',admin,(req,res) => {
    const old = db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.workspaceId);
    const name = req.body.name === undefined ? old.name : nameInput(req.body.name);
    const origins = req.body.origins === undefined ? JSON.parse(old.origins) : originsInput(req.body.origins);
    db.prepare('UPDATE workspaces SET name=?,origins=? WHERE id=?').run(name,JSON.stringify(origins),req.workspaceId);
    res.json({...workspaceView({...old,name,origins:JSON.stringify(origins)}),role:req.role});
  });
  app.get('/api/workspaces/:workspaceId/members',admin,(req,res) => {
    const members = db.prepare('SELECT u.id,u.name,u.email,u.is_owner,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.name').all(req.workspaceId);
    const invites = db.prepare('SELECT id,email,role,expires,created_at FROM invites WHERE workspace_id=? AND used_at IS NULL AND expires>? ORDER BY created_at DESC').all(req.workspaceId,Date.now());
    res.json({members:members.map(m=>({...publicUser(m),role:m.is_owner?'owner':m.role})),invites});
  });
  app.post('/api/workspaces/:workspaceId/invites',admin,(req,res) => {
    const email = emailInput(req.body.email), role = roleInput(req.body.role);
    const user = db.prepare('SELECT id,is_owner FROM users WHERE email=?').get(email);
    if (user && (user.is_owner || db.prepare('SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?').get(req.workspaceId,user.id))) fail(409, 'Esta pessoa já tem acesso. Altere a permissão na lista de membros.');
    const id = randomUUID(), token = newToken(), expires = Date.now()+7*24*3600000;
    transaction(() => {
      db.prepare('DELETE FROM invites WHERE workspace_id=? AND email=? AND used_at IS NULL').run(req.workspaceId,email);
      db.prepare('INSERT INTO invites (id,token_hash,workspace_id,email,role,invited_by,expires,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,digest(token),req.workspaceId,email,role,req.user.id,expires,new Date().toISOString());
    });
    res.status(201).json({id,token,expires,email,role});
  });
  app.delete('/api/workspaces/:workspaceId/invites/:id',admin,(req,res) => {
    if (!db.prepare('DELETE FROM invites WHERE id=? AND workspace_id=?').run(req.params.id,req.workspaceId).changes) fail(404,'Convite não encontrado.');
    res.json({ok:true});
  });
  function memberTarget(req) {
    const user = db.prepare('SELECT u.* FROM users u JOIN memberships m ON u.id=m.user_id WHERE m.workspace_id=? AND u.id=?').get(req.workspaceId,req.params.userId);
    if (!user) fail(404,'Membro não encontrado.');
    if (user.is_owner || user.id === req.user.id) fail(403,'Você não pode alterar seu próprio acesso ou o da administração FolkSales.');
    return user;
  }
  app.patch('/api/workspaces/:workspaceId/members/:userId',admin,(req,res) => {
    const user = memberTarget(req), role = roleInput(req.body.role);
    transaction(() => {
      db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(role,req.workspaceId,user.id);
      if (role !== 'admin') db.prepare('DELETE FROM invites WHERE workspace_id=? AND invited_by=? AND used_at IS NULL').run(req.workspaceId,user.id);
    });
    res.json({ok:true});
  });
  app.delete('/api/workspaces/:workspaceId/members/:userId',admin,(req,res) => {
    const user = memberTarget(req);
    transaction(() => {
      db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(req.workspaceId,user.id);
      db.prepare('DELETE FROM invites WHERE workspace_id=? AND (email=? OR invited_by=?) AND used_at IS NULL').run(req.workspaceId,user.email,user.id);
    });
    res.json({ok:true});
  });
  return { requireRoles, admin };
}
