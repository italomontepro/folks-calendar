import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.js';
import { createWorker } from '../server/worker.js';
import { msgcountWindow, msgcountDue, msgcountInput, formatMsgcount, samePhone, collectMsgcount, saveMsgcount, getMsgcount } from '../server/msgcount.js';

const CH = 'ef1bc4a1-d30b-4008-9983-8f4053f5b815', TPL = 'ffc1faf4-e301-4af9-a2ed-3099437314d5';
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'folks-msgcount-')), store = await openStore(dir), ws = store.db.prepare('SELECT id FROM workspaces').get().id;
  try { await fn(store, ws); } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('cada envio cobre o período desde o horário anterior (7h, 14h, 22h em Manaus)', () => {
  const hours = [7, 14, 22];
  // 09/11 07:30 Manaus = 11:30Z → janela 08/11 22:00 até 09/11 07:00
  let w = msgcountWindow(hours, new Date('2026-11-09T11:30:00Z'));
  assert.equal(w.start, '2026-11-09T02:00:00.000Z'); assert.equal(w.end, '2026-11-09T11:00:00.000Z');
  assert.equal(w.label, '08/11 22:00 → 09/11 07:00');
  w = msgcountWindow(hours, new Date('2026-11-09T18:05:00Z')); // 14:05
  assert.equal(w.start, '2026-11-09T11:00:00.000Z'); assert.equal(w.end, '2026-11-09T18:00:00.000Z');
  assert.equal(w.label, '09/11 · 07:00–14:00');
  w = msgcountWindow(hours, new Date('2026-11-10T03:00:00Z')); // 09/11 23:00
  assert.equal(w.start, '2026-11-09T18:00:00.000Z'); assert.equal(w.end, '2026-11-10T02:00:00.000Z');
  w = msgcountWindow(hours, new Date('2026-11-10T09:00:00Z')); // 10/11 05:00 → ainda a janela das 22h
  assert.equal(w.end, '2026-11-10T02:00:00.000Z');
});

test('dispara só nas duas horas seguintes ao horário', () => {
  const config = { hours: [7, 14, 22] };
  assert.deepEqual(msgcountDue(config, new Date('2026-11-09T10:59:00Z')), []);
  assert.deepEqual(msgcountDue(config, new Date('2026-11-09T11:00:05Z')), ['2026-11-09T11:00:00.000Z']);
  assert.deepEqual(msgcountDue(config, new Date('2026-11-09T13:30:00Z')), []);
  assert.deepEqual(msgcountDue(config, new Date('2026-11-10T03:00:00Z')), ['2026-11-10T02:00:00.000Z']);
});

test('valida configuração', () => {
  const ok = msgcountInput({ enabled: true, channelId: CH, templateId: TPL, recipients: '92981572606\n5592984532273' });
  assert.deepEqual(ok.hours, [7, 14, 22]); assert.equal(ok.button, 'Verificar Agora');
  assert.throws(() => msgcountInput({ enabled: true, recipients: ['5592984532273'] }), /canal, modelo/);
  assert.throws(() => msgcountInput({ hours: [25] }), /horários/);
  assert.throws(() => msgcountInput({ recipients: ['abc'] }), /inválido/);
});

test('compara WhatsApp com e sem DDI e com e sem o nono dígito', () => {
  assert.ok(samePhone('5592981572606', '559281572606'));
  assert.ok(samePhone('92981572606', '5592981572606'));
  assert.ok(samePhone('5511983040782', '+55 (11) 98304-0782'));
  assert.ok(!samePhone('5592981572606', '5592981572607'));
  assert.ok(!samePhone('', ''));
});

test('agrupa equipes por marca, mostra subtotais e total geral', () => {
  const text = formatMsgcount({ window: { label: '09/11 · 07:00–14:00' }, teams: {
    'Body Monster - Vieiralves': 120, 'Body Monster - Manauara': 85, 'Vyta Verde-Delivery': 13, 'Vyta Verde - Vieiralves': 0,
    'Pacco': 86, 'Quiosque Pacco': 4, 'SAC': 3, 'Financeiro': 0 } });
  assert.match(text, /\*Body Monster\*\nBody Monster - Manauara: 85\nBody Monster - Vieiralves: 120\n\*Total Body Monster: 205\*/);
  assert.match(text, /Vyta Verde - Vieiralves: 0/);
  assert.match(text, /\*Total Pacco: 90\*/);
  assert.match(text, /\*Outras equipes\*\nSAC: 3/);
  assert.doesNotMatch(text, /Financeiro/);
  assert.match(text, /\*Total geral: 311\*/);
});

test('conta só mensagens recebidas dentro da janela, pela equipe da conversa', async () => {
  const window = { start: '2026-11-09T11:00:00.000Z', end: '2026-11-09T18:00:00.000Z', label: 'x' };
  const calls = [];
  const fetcher = async url => {
    calls.push(url.pathname + url.search);
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (url.pathname === '/core/v2/department') return json([{ id: 'a', name: 'Pacco' }, { id: 'b', name: 'Body Monster - Vieiralves' }]);
    if (url.pathname === '/chat/v2/session') {
      assert.equal(url.searchParams.get('UpdatedAt.After'), window.start);
      return json({ items: [{ id: 's1', departmentId: 'a', createdAt: '2026-11-01T00:00:00Z' }, { id: 's2', departmentId: 'b' }, { id: 's3', departmentId: null }, { id: 's4', departmentId: 'a', createdAt: '2026-11-09T19:00:00Z' }], hasMorePages: false });
    }
    if (url.pathname === '/chat/v1/message') {
      assert.equal(url.searchParams.get('CreatedAt.Before'), window.end);
      const id = url.searchParams.get('SessionId');
      const items = { s1: [{ direction: 'TO_HUB' }, { direction: 'TO_HUB' }, { direction: 'FROM_HUB' }], s2: [{ direction: 'TO_HUB' }], s3: [{ direction: 'TO_HUB' }] }[id];
      return json({ items, hasMorePages: false });
    }
    throw new Error('rota inesperada ' + url);
  };
  const data = await collectMsgcount('t', window, fetcher, 1000);
  assert.deepEqual(data.teams, { 'Pacco': 2, 'Body Monster - Vieiralves': 1, 'Sem equipe': 1 });
  assert.ok(!calls.some(c => c.includes('SessionId=s4')), 'conversa criada depois da janela não é consultada');
});

test('worker envia o modelo uma vez por horário, pelo canal configurado, e calcula a contagem', async () => fixture(async (store, ws) => {
  const { db } = store;
  db.prepare('INSERT INTO integrations VALUES (?,?,?,?,?)').run(ws, 'account', 'rev', 'secret', 'x');
  saveMsgcount(db, ws, { enabled: true, channelId: CH, templateId: TPL, hours: [0, 6, 12, 18], recipients: ['5592981572606', '5592984532273'] });
  // Garante que algum horário venceu há menos de 2h.
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Manaus', hour: 'numeric', hourCycle: 'h23' }).format(now));
  saveMsgcount(db, ws, { ...getMsgcount(db, ws), hours: [hour, (hour + 8) % 24, (hour + 16) % 24] });
  const sends = [], snapshots = [];
  const worker = createWorker(store, {
    helena: async (token, path, body) => { sends.push({ path, body }); return { id: 'p' + sends.length, status: 'QUEUED' }; },
    channels: async () => [{ id: 'outro', number: '5592000000000' }, { id: CH, number: '5592981586710' }],
    snapshot: async (_db, workspace, window) => { snapshots.push(window); return {}; }
  });
  await worker.tick(); await worker.tick();
  assert.equal(sends.length, 2);
  assert.ok(sends.every(s => s.path === 'send/template' && s.body.from === '5592981586710' && s.body.templateId === TPL));
  assert.deepEqual(sends.map(s => s.body.to).sort(), ['5592981572606', '5592984532273']);
  assert.equal(snapshots.length, 1);
}));
