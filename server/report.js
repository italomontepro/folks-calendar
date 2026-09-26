import { channels, getIntegration, helenaRequest } from './helena.js';
import { fail } from './security.js';

const ORIGIN = 'https://api.wts.chat';
const REFRESH_MS = 15 * 60_000;
const PAGE_SIZE = 100;
const cache = new Map();
const zone = 'America/Manaus';

function monthBounds(month) {
  if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month)) fail(400, 'Informe o mês no formato AAAA-MM.');
  const [year, number] = month.split('-').map(Number);
  // Manaus uses UTC-04:00 throughout the reporting period.
  const start = new Date(Date.UTC(year, number - 1, 1, 4));
  const end = new Date(Date.UTC(year, number, 1, 4));
  const previous = new Date(Date.UTC(year, number - 2, 1, 4));
  return { start: start.toISOString(), end: end.toISOString(), previous: previous.toISOString() };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function helenaGet(token, path, params = {}, fetcher = fetch) {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, item));
    else if (value != null) url.searchParams.set(key, value);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(30_000)
    });
    if (response.status === 429 && attempt < 2) { await sleep(2_000 * (attempt + 1)); continue; }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'Token do Helena sem permissão para consultar o relatório.'
      : `Helena retornou HTTP ${response.status} ao consultar ${path}.`);
    return response.json();
  }
}

async function pages(token, path, params) {
  const items = [];
  for (let page = 1; page <= 1000; page++) {
    const result = await helenaGet(token, path, { ...params, PageNumber: page, PageSize: PAGE_SIZE });
    if (!Array.isArray(result?.items)) throw new Error('O Helena retornou uma lista inválida.');
    items.push(...result.items);
    if (!result.hasMorePages) return items;
    await sleep(160);
  }
  throw new Error('A consulta ultrapassou 100.000 registros; reduza o período.');
}

export function parseDuration(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

function localParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(value);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function manausBoundary(year, month, day, hour = 0) {
  // Manaus is UTC−04:00 for the reporting period.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) + 4));
}

export function messageReportWindow(now = new Date()) {
  const parts = localParts(now);
  const day = manausBoundary(parts.year, parts.month, parts.day);
  if (parts.weekday === 'Sun') {
    const start = new Date(day);
    start.setUTCDate(start.getUTCDate() - 6);
    return {
      start: start.toISOString(), end: day.toISOString(), kind: 'week',
      label: `segunda a sábado · ${start.toLocaleDateString('pt-BR', { timeZone: zone })} a ${new Date(day.getTime() - 1).toLocaleDateString('pt-BR', { timeZone: zone })}`
    };
  }
  const end = manausBoundary(parts.year, parts.month, parts.day, 20);
  return {
    start: day.toISOString(), end: end.toISOString(), kind: 'day',
    label: `${day.toLocaleDateString('pt-BR', { timeZone: zone })} · 00:00–20:00`
  };
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value || 0).replace(/\u00a0/g, ' ');
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) return 'sem dados';
  const rounded = Math.round(value);
  if (rounded >= 3600) return `${Math.floor(rounded / 3600)}h ${String(Math.floor(rounded % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, '0')}s`;
}

export function formatMessageReport(data, window = messageReportWindow()) {
  const sessions = data.sessions || [];
  const completed = sessions.filter(s => s.status === 'COMPLETED').length;
  const waits = sessions.filter(s => Number.isFinite(s.waitSeconds));
  const services = sessions.filter(s => Number.isFinite(s.serviceSeconds));
  const first = sessions.filter(s => Number.isFinite(s.firstSeconds));
  const avg = (items, key) => items.length ? items.reduce((sum, item) => sum + item[key], 0) / items.length : null;
  const cards = Object.values(data.cardsByPanel || {}).flat();
  const won = cards.filter(c => c.status === 'WON');
  const revenue = won.reduce((sum, card) => sum + (Number(card.amount) || 0), 0);
  const channelsByName = sessions.reduce((map, session) => map.set(session.channel || 'Não informado', (map.get(session.channel || 'Não informado') || 0) + 1), new Map());
  const channelsText = [...channelsByName.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name}: ${count}`).join(' · ') || 'sem conversas';
  const title = window.kind === 'week' ? 'Resumo semanal de atendimento' : 'Resumo diário de atendimento';
  return [
    `📊 ${title}`,
    window.label,
    '',
    `Conversas: ${sessions.length}`,
    `Concluídas: ${completed} (${sessions.length ? (completed / sessions.length * 100).toFixed(1).replace('.', ',') : '0,0'}%)`,
    `Espera média: ${formatSeconds(avg(waits, 'waitSeconds'))}`,
    `Atendimento médio: ${formatSeconds(avg(services, 'serviceSeconds'))}`,
    `1ª resposta em até 5 min: ${first.length ? (first.filter(s => s.firstSeconds <= 300).length / first.length * 100).toFixed(1).replace('.', ',') : 'sem dados'}${first.length ? '%' : ''}`,
    `Canais: ${channelsText}`,
    '',
    `Negócios ganhos: ${won.length}`,
    `Receita ganha: ${formatMoney(revenue)}`,
    '',
    'Folks · Helena CRM'
  ].join('\n');
}

export async function sendMessageReport(db, workspaceId, { to, sessionId }) {
  const integration = getIntegration(db, workspaceId);
  if (!integration) throw new Error('Conecte o Helena neste workspace antes de enviar o relatório.');
  const window = messageReportWindow();
  const token = integration.token;
  const [channelList, panelResult, sessions] = await Promise.all([
    channels(token),
    pages(token, '/crm/v2/panel', { IncludeDetails: ['Steps'] }),
    pages(token, '/chat/v2/session', { 'CreatedAt.After': window.start, 'CreatedAt.Before': window.end, IncludeDetails: ['ChannelDetails'] })
  ]);
  const panels = panelResult.filter(p => p.type === 'SALES' && !p.archived);
  const cardsByPanel = {};
  for (const panel of panels) {
    const cards = await pages(token, '/crm/v2/panel/card', {
      PanelId: panel.id, 'CreatedAt.After': window.start, 'CreatedAt.Before': window.end,
      IncludeDetails: ['StepTitle', 'LostReason']
    });
    cardsByPanel[panel.id] = cards.map(c => ({ status: c.status, amount: c.monetaryAmount }));
  }
  const data = { cardsByPanel, sessions: sessions.map(s => ({
    status: s.status, channel: s.channelType || s.channelDetails?.type || 'UNKNOWN',
    waitSeconds: parseDuration(s.timeWait), serviceSeconds: parseDuration(s.timeService),
    firstSeconds: s.firstResponseAt ? Math.max(0, (Date.parse(s.firstResponseAt) - Date.parse(s.createdAt)) / 1000) : null
  })) };
  const from = channelList[0]?.number;
  if (!from) throw new Error('Nenhum canal oficial ativo do Helena foi encontrado para enviar o relatório.');
  const recipient = String(to || '').replace(/\D/g, '');
  if (!/^[1-9]\d{9,14}$/.test(recipient)) throw new Error('O HELENA não informou um WhatsApp válido para o relatório.');
  const text = formatMessageReport(data, window);
  const result = await helenaRequest(token, 'send/text', {
    from, to: recipient, text,
    ...(sessionId ? { sessionId } : {}), senderId: `folks-report:${workspaceId}:${window.start}`
  });
  if (!result?.id) throw new Error('O Helena não retornou o ID do envio do relatório.');
  return result;
}

export async function collectReport(db, workspaceId, month) {
  const integration = getIntegration(db, workspaceId);
  if (!integration) fail(400, 'Conecte o Helena neste workspace antes de abrir o relatório.');
  const bounds = monthBounds(month);
  const token = integration.token;
  const [departments, agents, panelResult, sessions, previousSessions] = await Promise.all([
    helenaGet(token, '/core/v2/department'),
    helenaGet(token, '/core/v1/agent'),
    pages(token, '/crm/v2/panel', { IncludeDetails: ['Steps'] }),
    pages(token, '/chat/v2/session', { 'CreatedAt.After': bounds.start, 'CreatedAt.Before': bounds.end, IncludeDetails: ['ChannelDetails'] }),
    helenaGet(token, '/chat/v2/session', { 'CreatedAt.After': bounds.previous, 'CreatedAt.Before': bounds.start, PageNumber: 1, PageSize: 1 })
  ]);
  if (!Array.isArray(departments) || !Array.isArray(agents)) throw new Error('O Helena retornou equipes ou atendentes em formato inválido.');
  const panels = panelResult.filter(p => p.type === 'SALES' && !p.archived).map(p => ({
    id: p.id, name: p.title,
    steps: (p.steps || []).filter(s => !s.archived).sort((a, b) => a.position - b.position).map(s => ({ id: s.id, name: s.title, isInitial: s.isInitial, isFinal: s.isFinal }))
  }));
  const cardsByPanel = {};
  for (const panel of panels) {
    const cards = await pages(token, '/crm/v2/panel/card', {
      PanelId: panel.id, 'CreatedAt.After': bounds.start, 'CreatedAt.Before': bounds.end,
      IncludeDetails: ['StepTitle', 'LostReason']
    });
    cardsByPanel[panel.id] = cards.map(c => ({
      id: c.id, stepId: c.stepId, status: c.status, amount: c.monetaryAmount,
      overdue: c.isOverdue, userId: c.responsibleUserId, sessionId: c.sessionId,
      lostReason: c.lostReason?.name || null
    }));
  }
  return {
    month, updatedAt: new Date().toISOString(), previousTotal: previousSessions.totalItems || 0,
    departments: departments.map(d => ({ id: d.id, name: d.name })),
    agents: agents.map(a => ({ id: a.userId, name: a.name, departments: (a.departments || []).map(d => d.departmentId) })),
    panels, cardsByPanel,
    sessions: sessions.map(s => ({
      id: s.id, createdAt: s.createdAt, status: s.status, departmentId: s.departmentId,
      userId: s.userId, channel: s.channelType || s.channelDetails?.type || 'UNKNOWN',
      waitSeconds: parseDuration(s.timeWait), serviceSeconds: parseDuration(s.timeService),
      firstSeconds: s.firstResponseAt ? Math.max(0, (Date.parse(s.firstResponseAt) - Date.parse(s.createdAt)) / 1000) : null
    }))
  };
}

export function installReport(app, db, base) {
  async function refresh(key, workspaceId, month) {
    const item = cache.get(key);
    if (item?.promise) return item.promise;
    const promise = collectReport(db, workspaceId, month).then(data => {
      cache.set(key, { data, expires: Date.now() + REFRESH_MS, lastAccess: Date.now() });
      return data;
    }).catch(error => {
      if (item?.data) {
        cache.set(key, { ...item, error: error.message, expires: Date.now() + 60_000, lastAccess: Date.now() });
        return item.data;
      }
      cache.delete(key);
      throw error;
    });
    cache.set(key, { ...item, promise, lastAccess: Date.now() });
    return promise;
  }
  app.get(base + '/report', async (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : currentMonth();
    monthBounds(month);
    const integration = getIntegration(db, req.workspaceId);
    if (!integration) fail(400, 'Conecte o Helena neste workspace antes de abrir o relatório.');
    const key = `${req.workspaceId}|${integration.revision}|${month}`;
    const cached = cache.get(key);
    if (cached?.data && cached.expires > Date.now()) {
      cached.lastAccess = Date.now();
      return res.json({ ...cached.data, syncError: cached.error || null });
    }
    try {
      const data = await refresh(key, req.workspaceId, month);
      res.json({ ...data, syncError: cache.get(key)?.error || null });
    } catch (error) {
      console.error('HELENA report:', error);
      res.status(error.status || 502).json({ error: error.status ? error.message : 'Não foi possível atualizar o relatório pelo Helena.' });
    }
  });
  const timer = setInterval(() => {
    for (const [key, item] of cache) {
      const [workspaceId, revision, month] = key.split('|');
      if (getIntegration(db, workspaceId)?.revision !== revision) { cache.delete(key); continue; }
      if (Date.now() - item.lastAccess > 60 * 60_000) { cache.delete(key); continue; }
      if (item.expires <= Date.now() && !item.promise) {
        refresh(key, workspaceId, month).catch(error => console.error('HELENA report refresh:', error));
      }
    }
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
