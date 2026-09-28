import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageReport, messageReportWindow, weeklyReportWindow, parseDuration } from '../server/report.js';
import { dayOf, summarize, teamForCard } from '../src/reportMetrics.js';

test('tempos do Helena podem ultrapassar 24 horas e a data segue Manaus', () => {
  assert.equal(parseDuration('152:18:34'), 548314);
  assert.equal(parseDuration(null), null);
  assert.equal(dayOf('2026-09-02T02:30:00Z'), 1);
});

test('métricas usam denominadores conhecidos e mantêm as contagens exatas', () => {
  const sessions = [
    { createdAt: '2026-09-01T12:00:00Z', status: 'COMPLETED', channel: 'INSTAGRAM', waitSeconds: 120, serviceSeconds: 600, firstSeconds: 240 },
    { createdAt: '2026-09-01T14:00:00Z', status: 'IN_PROGRESS', channel: 'INSTAGRAM', waitSeconds: null, serviceSeconds: null, firstSeconds: null },
    { createdAt: '2026-09-02T12:00:00Z', status: 'PENDING', channel: 'CLOUDAPI_WHATSAPP', waitSeconds: 360, serviceSeconds: 300, firstSeconds: 420 }
  ];
  const cards = [
    { status: 'WON', amount: 100, stepId: 'done', overdue: false },
    { status: 'LOST', amount: 500, stepId: 'done', lostReason: 'Preço', overdue: false },
    { status: 'OPEN', amount: 250, stepId: 'lead', overdue: true }
  ];
  const result = summarize(sessions, cards, { month: '2026-09', steps: [{ id: 'lead', name: 'Lead' }, { id: 'done', name: 'Ganho' }] });
  assert.equal(result.total, 3);
  assert.equal(result.wait, 240);
  assert.equal(result.waitCount, 2);
  assert.equal(result.first, 0.5);
  assert.equal(result.completed, 1 / 3);
  assert.deepEqual(result.daily.slice(0, 2), [2, 1]);
  assert.equal(result.channels.reduce((sum, row) => sum + row.total, 0), 3);
  assert.equal(result.won, 1);
  assert.equal(result.revenue, 100);
  assert.equal(result.conversion, 1 / 3);
  assert.equal(result.steps[0].count, 1);
  assert.equal(result.steps[1].count, 0);
  assert.equal(result.reasons[0].name, 'Preço');
  assert.equal(result.overdue, 1);
});

test('card de atendente em duas equipes usa a equipe da conversa vinculada', () => {
  const sessions = new Map([['session', { departmentId: 'social' }]]);
  const agents = new Map([['agent', { departments: ['social', 'geral'] }]]);
  assert.equal(teamForCard({ sessionId: 'session', userId: 'agent' }, sessions, agents), 'social');
  assert.equal(teamForCard({ sessionId: null, userId: 'agent' }, sessions, agents), null);
});

test('resumo por mensagem usa o dia até 20h e domingo fecha a semana de segunda a sábado', () => {
  const saturday = messageReportWindow(new Date('2026-09-26T16:00:00Z'));
  assert.equal(saturday.kind, 'day');
  assert.equal(saturday.start, '2026-09-26T04:00:00.000Z');
  assert.equal(saturday.end, '2026-09-27T00:00:00.000Z');
  const sunday = messageReportWindow(new Date('2026-09-27T16:00:00Z'));
  assert.equal(sunday.kind, 'week');
  assert.equal(sunday.start, '2026-09-21T04:00:00.000Z');
  assert.equal(sunday.end, '2026-09-27T04:00:00.000Z');
});

test('resumo por mensagem contém atendimento, canais e vendas', () => {
  const text = formatMessageReport({
    sessions: [
      { status: 'COMPLETED', channel: 'INSTAGRAM', waitSeconds: 120, serviceSeconds: 600, firstSeconds: 240 },
      { status: 'IN_PROGRESS', channel: 'INSTAGRAM', waitSeconds: null, serviceSeconds: null, firstSeconds: null }
    ],
    cardsByPanel: { sales: [{ status: 'WON', amount: 250 }] }
  }, { kind: 'day', label: '26/09/2026 · 00:00–20:00' }, 'https://exemplo.test/relatorio?workspace=abc');
  assert.match(text, /Resumo diário de atendimento/);
  assert.match(text, /Relatório completo: https:\/\/exemplo\.test\/relatorio\?workspace=abc/);
  assert.match(text, /Conversas: 2/);
  assert.match(text, /Canais: INSTAGRAM: 2/);
  assert.match(text, /Receita ganha: R\$ 250/);
});

test('semanal sob demanda usa a última semana completa de segunda a sábado', () => {
  const monday = weeklyReportWindow(new Date('2026-09-28T17:00:00Z'));
  assert.equal(monday.start, '2026-09-21T04:00:00.000Z');
  assert.equal(monday.end, '2026-09-27T04:00:00.000Z');
  const sunday = weeklyReportWindow(new Date('2026-09-27T16:00:00Z'));
  assert.equal(sunday.start, '2026-09-21T04:00:00.000Z');
  assert.match(monday.label, /21\/09\/2026 a 26\/09\/2026/);
});

test('bloco de vendas do resumo traz ganhos, perdas, andamento, conversão, ticket, motivo, ciclo e funil', () => {
  const text = formatMessageReport({ sessions: [], cardsByPanel: {}, sales: [{
    panel: 'Conversas Internas',
    won: { count: 2, amount: 3000 }, lost: { count: 3, amount: 900 }, open: { count: 15, amount: 20000 },
    newLeads: 7, topLostReason: 'Sem resposta do lead', cycleDays: 11.28,
    funnel: [{ name: 'Primeiro Contato', count: 1, amount: 0 }, { name: 'Oportunidade', count: 14, amount: 20000 }]
  }] }, { kind: 'day', label: 'hoje' });
  assert.match(text, /💼 Vendas · Conversas Internas/);
  assert.match(text, /Ganhos: 2 · R\$ 3\.000/);
  assert.match(text, /Em andamento: 15 · R\$ 20\.000/);
  assert.match(text, /Taxa de conversão: 10,0%/);
  assert.match(text, /Ticket médio: R\$ 1\.500/);
  assert.match(text, /Principal motivo de perda: Sem resposta do lead/);
  assert.match(text, /Ciclo médio de venda: 11,3 dias/);
  assert.match(text, /🔻 Funil · cards em aberto por etapa\nPrimeiro Contato: 1\nOportunidade: 14 · R\$ 20\.000\n\nFolkSales/);
});
