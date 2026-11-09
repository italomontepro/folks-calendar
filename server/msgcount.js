import { getIntegration, helenaRequest, channels } from './helena.js';
import { fail } from './security.js';

// Message-volume report by team. Three times a day a template with a button
// goes to a fixed list of numbers; the click answers, in the same chat, with
// the number of messages received from customers per HELENA team during the
// window that ended at that slot, grouped by brand.

const ORIGIN = 'https://api.wts.chat';
const zone = 'America/Manaus';
const CONCURRENCY = 4;
const RATE = 6; // requests per second

export const DEFAULT_MSGCOUNT = {
  enabled: false,
  channelId: '',
  templateId: '',
  button: 'Verificar Agora',
  hours: [7, 14, 22],
  groups: ['Body Monster', 'Vyta Verde', 'Pacco'],
  recipients: []
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export function getMsgcount(db, workspaceId) {
  const row = db.prepare('SELECT body FROM msgcount_schedules WHERE workspace_id=?').get(workspaceId);
  return row ? { ...DEFAULT_MSGCOUNT, ...JSON.parse(row.body) } : { ...DEFAULT_MSGCOUNT };
}

function cleanList(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,;]+/) : [];
}

export function msgcountInput(input) {
  if (!input || typeof input !== 'object') fail(400, 'Informe a configuração do relatório de mensagens.');
  const recipients = [...new Set(cleanList(input.recipients).map(v => String(v || '').replace(/[\s()+.-]/g, '')).filter(Boolean))];
  if (recipients.length > 20) fail(400, 'Informe no máximo 20 números.');
  const invalid = recipients.find(n => !/^[1-9]\d{9,14}$/.test(n));
  if (invalid) fail(400, `WhatsApp inválido: ${invalid}. Use DDI e DDD, por exemplo 5592984532273.`);
  const hours = [...new Set(cleanList(input.hours ?? DEFAULT_MSGCOUNT.hours).map(Number))].sort((a, b) => a - b);
  if (!hours.length || hours.length > 6 || hours.some(h => !Number.isInteger(h) || h < 0 || h > 23)) fail(400, 'Informe de 1 a 6 horários entre 0 e 23.');
  const groups = [...new Set(cleanList(input.groups ?? DEFAULT_MSGCOUNT.groups).map(v => String(v || '').trim()).filter(Boolean))];
  if (groups.length > 20 || groups.some(g => g.length > 60)) fail(400, 'Informe no máximo 20 grupos de até 60 caracteres.');
  const channelId = String(input.channelId || '').trim();
  const templateId = String(input.templateId || '').trim();
  const button = String(input.button || DEFAULT_MSGCOUNT.button).trim();
  if (channelId && !/^[a-f0-9-]{36}$/i.test(channelId)) fail(400, 'Selecione o canal.');
  if (templateId && !/^[a-f0-9-]{36}$/i.test(templateId)) fail(400, 'Selecione o modelo.');
  if (!button || button.length > 40) fail(400, 'Informe o texto do botão do modelo.');
  const enabled = input.enabled === true;
  if (enabled && (!recipients.length || !channelId || !templateId)) fail(400, 'Para ativar, informe canal, modelo e pelo menos um WhatsApp.');
  return { enabled, channelId, templateId, button, hours, groups, recipients };
}

export function saveMsgcount(db, workspaceId, input) {
  const config = msgcountInput(input);
  db.prepare('INSERT INTO msgcount_schedules (workspace_id, body) VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET body=excluded.body')
    .run(workspaceId, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }));
  return getMsgcount(db, workspaceId);
}

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(value);
  const map = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return map;
}

// Manaus is UTC−04:00 all year (no daylight saving).
function manaus(year, month, day, hour) {
  return new Date(Date.UTC(year, month - 1, day, hour + 4));
}

const pad = n => String(n).padStart(2, '0');
const hourLabel = date => `${pad(localParts(date).hour)}:00`;
const dayLabel = date => date.toLocaleDateString('pt-BR', { timeZone: zone, day: '2-digit', month: '2-digit' });

// The window that ended at the most recent slot at or before `now`. Each slot
// covers the time since the previous slot, so the slots together cover 24h.
export function msgcountWindow(hours, now = new Date()) {
  const sorted = [...hours].sort((a, b) => a - b);
  const p = localParts(now);
  const candidates = [];
  for (const offset of [0, -1]) {
    for (const h of sorted) {
      const d = manaus(p.year, p.month, p.day, h);
      d.setUTCDate(d.getUTCDate() + offset);
      if (d <= now) candidates.push(d);
    }
  }
  const end = new Date(Math.max(...candidates.map(d => d.getTime())));
  const endHour = localParts(end).hour;
  const index = sorted.indexOf(endHour);
  const previousHour = sorted[(index - 1 + sorted.length) % sorted.length];
  let start = new Date(end.getTime() - (((endHour - previousHour) + 24) % 24 || 24) * 3600_000);
  const label = dayLabel(start) === dayLabel(end)
    ? `${dayLabel(end)} · ${hourLabel(start)}–${hourLabel(end)}`
    : `${dayLabel(start)} ${hourLabel(start)} → ${dayLabel(end)} ${hourLabel(end)}`;
  return { start: start.toISOString(), end: end.toISOString(), label, key: `${end.toISOString()}` };
}

// Slots that came due in the last two hours and were not yet fired. A slot
// missed by more than two hours (server down) is not replayed.
export function msgcountDue(config, now = new Date()) {
  const p = localParts(now);
  const due = [];
  for (const offset of [0, -1]) {
    for (const h of config.hours) {
      const d = manaus(p.year, p.month, p.day, h);
      d.setUTCDate(d.getUTCDate() + offset);
      const elapsed = now.getTime() - d.getTime();
      if (elapsed >= 0 && elapsed <= 2 * 3600_000) due.push(d.toISOString());
    }
  }
  return due;
}

// The account shares one rate limit with HELENA's own apps and other
// integrations: pace every call and back off on 429, honouring Retry-After.
function limiter(perSecond) {
  let next = 0;
  return async () => {
    const now = Date.now(), at = Math.max(now, next);
    next = at + 1000 / perSecond;
    if (at > now) await sleep(at - now);
  };
}

async function helenaGet(token, path, params = {}, fetcher = fetch, pace = async () => {}) {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, value);
  for (let attempt = 0; attempt < 8; attempt++) {
    await pace();
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status === 429 && attempt < 7) {
      const retry = Number(response.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(retry) && retry > 0 ? Math.min(retry, 60) * 1000 : Math.min(30_000, 2_000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) throw new Error(`Helena retornou HTTP ${response.status} ao consultar ${path}.`);
    return response.json();
  }
}

async function pages(token, path, params, fetcher, pace) {
  const items = [];
  for (let page = 1; page <= 500; page++) {
    const result = await helenaGet(token, path, { ...params, PageNumber: page, PageSize: 100 }, fetcher, pace);
    if (!Array.isArray(result?.items)) throw new Error('O Helena retornou uma lista inválida.');
    items.push(...result.items);
    if (!result.hasMorePages) return items;
  }
  throw new Error('A consulta ultrapassou 50.000 registros.');
}

// Counts customer messages (FROM_HUB; TO_HUB is the team's own replies) created inside the window, per team. The
// message API has no team filter, so the team is the conversation's current
// team; a conversation transferred later is counted in its final team.
export async function collectMsgcount(token, window, fetcher = fetch, perSecond = RATE) {
  const pace = limiter(perSecond);
  const [departments, sessions] = await Promise.all([
    helenaGet(token, '/core/v2/department', {}, fetcher, pace),
    pages(token, '/chat/v2/session', { 'UpdatedAt.After': window.start }, fetcher, pace)
  ]);
  if (!Array.isArray(departments)) throw new Error('O Helena retornou equipes em formato inválido.');
  const names = new Map(departments.map(d => [d.id, d.name]));
  const received = new Map(departments.map(d => [d.name, 0]));
  const queue = sessions.filter(s => !s.createdAt || s.createdAt < window.end);
  async function worker() {
    while (queue.length) {
      const session = queue.shift();
      const messages = await pages(token, '/chat/v1/message', { SessionId: session.id, 'CreatedAt.After': window.start, 'CreatedAt.Before': window.end }, fetcher, pace);
      const count = messages.filter(m => m.direction === 'FROM_HUB').length;
      if (!count) continue;
      const name = names.get(session.departmentId) || 'Sem equipe';
      received.set(name, (received.get(name) || 0) + count);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { window, updatedAt: new Date().toISOString(), direction: 'FROM_HUB', teams: Object.fromEntries(received) };
}

const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const number = n => new Intl.NumberFormat('pt-BR').format(n);

export function formatMsgcount(data, groups = DEFAULT_MSGCOUNT.groups) {
  const lines = ['📊 Mensagens recebidas por equipe', data.window.label, ''];
  const teams = Object.entries(data.teams).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  const used = new Set();
  let total = 0;
  for (const group of groups) {
    const members = teams.filter(([name]) => fold(name).includes(fold(group)));
    if (!members.length) continue;
    members.forEach(([name]) => used.add(name));
    const sum = members.reduce((acc, [, count]) => acc + count, 0);
    total += sum;
    lines.push(`*${group}*`);
    for (const [name, count] of members) lines.push(`${name}: ${number(count)}`);
    lines.push(`*Total ${group}: ${number(sum)}*`, '');
  }
  const others = teams.filter(([name, count]) => !used.has(name) && count > 0);
  if (others.length) {
    const sum = others.reduce((acc, [, count]) => acc + count, 0);
    total += sum;
    lines.push('*Outras equipes*');
    for (const [name, count] of others) lines.push(`${name}: ${number(count)}`);
    lines.push(`*Total outras: ${number(sum)}*`, '');
  }
  lines.push(`*Total geral: ${number(total)}*`, '', 'FolksBot');
  return lines.join('\n');
}

// Brazilian mobile numbers may arrive with or without the ninth digit.
export function samePhone(a, b) {
  const key = value => {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);
    if (digits.length === 11 && digits[2] === '9') digits = digits.slice(0, 2) + digits.slice(3);
    return digits;
  };
  const x = key(a), y = key(b);
  return !!x && x === y;
}

// Webhook messages carry only the session id; the phone is on the contact.
export async function sessionPhone(token, sessionId, fetcher = fetch) {
  const session = await helenaGet(token, `/chat/v2/session/${encodeURIComponent(sessionId)}`, {}, fetcher);
  if (!session?.contactId) return '';
  const contact = await helenaGet(token, `/core/v1/contact/${encodeURIComponent(session.contactId)}`, {}, fetcher);
  return String(contact?.phoneNumber || '').replace(/\D/g, '');
}

export async function channelNumber(token, channelId, list = channels) {
  const channel = (await list(token)).find(c => c.id === channelId);
  if (!channel) throw new Error('O canal configurado para o relatório de mensagens não está ativo no Helena.');
  return channel.number;
}

// Snapshots are computed when the template goes out, so the click answers
// immediately; on a miss (or a click before the snapshot is ready) the count
// is computed on demand.
const pending = new Map();
export function snapshot(db, workspaceId, window, { fetcher } = {}) {
  const row = db.prepare('SELECT body FROM msgcount_snapshots WHERE workspace_id=? AND window_end=?').get(workspaceId, window.end);
  const cached = row && JSON.parse(row.body);
  // Snapshots without the direction marker counted the team's replies.
  if (cached?.direction === 'FROM_HUB') return Promise.resolve(cached);
  const key = `${workspaceId}|${window.end}`;
  if (pending.has(key)) return pending.get(key);
  const integration = getIntegration(db, workspaceId);
  if (!integration) return Promise.reject(new Error('Conecte o Helena neste workspace.'));
  const promise = collectMsgcount(integration.token, window, fetcher).then(data => {
    db.prepare('INSERT OR REPLACE INTO msgcount_snapshots (workspace_id, window_end, body, created) VALUES (?,?,?,?)')
      .run(workspaceId, window.end, JSON.stringify(data), Date.now());
    db.prepare('DELETE FROM msgcount_snapshots WHERE created < ?').run(Date.now() - 7 * 86400_000);
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}

export async function sendMsgcount(db, workspaceId, { to, sessionId, now = new Date(), send = helenaRequest, list = channels } = {}) {
  const config = getMsgcount(db, workspaceId);
  const integration = getIntegration(db, workspaceId);
  if (!integration) throw new Error('Conecte o Helena neste workspace.');
  const data = await snapshot(db, workspaceId, msgcountWindow(config.hours, now));
  const from = await channelNumber(integration.token, config.channelId, list);
  const text = formatMsgcount(data, config.groups);
  const result = await send(integration.token, 'send/text', {
    from, to: String(to).replace(/\D/g, ''), text,
    ...(sessionId ? { sessionId } : {}), senderId: `folks-msgcount:${workspaceId}:${data.window.end}:${Date.now()}`
  });
  if (!result?.id) throw new Error('O Helena não retornou o ID do envio do relatório de mensagens.');
  return result;
}
