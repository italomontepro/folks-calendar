import React, { useEffect, useMemo, useState } from 'react';
import { request } from './api';
import { summarize, teamForCard } from './reportMetrics';
import './report.css';

const number = value => Number(value || 0).toLocaleString('pt-BR');
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`;
const money = value => value == null ? '—' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(value);
function duration(seconds) {
  if (seconds == null) return '—';
  const value = Math.round(seconds);
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${String(Math.floor(value % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`;
}
function monthNow() {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', timeZone: 'America/Manaus' }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}
const channelNames = { CLOUDAPI_WHATSAPP: 'WhatsApp Cloud', DIALOG360_WHATSAPP: 'WhatsApp 360', GUPSHUP_WHATSAPP: 'WhatsApp Gupshup', ZAPI_WHATSAPP: 'WhatsApp Z-API', EVOLUTIONAPI_WHATSAPP: 'WhatsApp Evolution', INSTAGRAM: 'Instagram', MESSENGER: 'Messenger', UNKNOWN: 'Não informado' };

function Card({ title, subtitle, children, source }) {
  return <section className="report-card"><div className="report-card-head"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{children}{source && <div className="report-source">{source}</div>}</section>;
}
function Kpi({ label, value, detail, hero = false }) {
  return <div className={`report-card report-kpi${hero ? ' report-hero' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}
function LineChart({ values, month }) {
  const width = 760, height = 220, left = 35, right = 12, top = 18, bottom = 30;
  const max = Math.max(1, ...values);
  const x = i => left + (values.length <= 1 ? 0 : i * (width - left - right) / (values.length - 1));
  const y = v => top + (height - top - bottom) * (1 - v / max);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return <div className="report-line-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Conversas por dia">
    {[0, 0.5, 1].map(f => <g key={f}><line x1={left} x2={width - right} y1={y(max * f)} y2={y(max * f)} className="report-grid-line"/><text x={left - 7} y={y(max * f) + 4} textAnchor="end">{number(max * f)}</text></g>)}
    <polygon points={`${left},${y(0)} ${points} ${x(values.length - 1)},${y(0)}`} className="report-area"/>
    <polyline points={points} className="report-line"/>
    {[0, Math.floor((values.length - 1) / 2), values.length - 1].map(i => <text key={i} x={x(i)} y={height - 5} textAnchor="middle">{String(i + 1).padStart(2, '0')}/{month.slice(5)}</text>)}
  </svg><div className="report-daily-table"><table><thead><tr><th>Dia</th><th>Conversas</th></tr></thead><tbody>{values.map((v, i) => <tr key={i}><td>{String(i + 1).padStart(2, '0')}/{month.slice(5)}</td><td>{number(v)}</td></tr>)}</tbody></table></div></div>;
}
function StackedChart({ rows }) {
  const max = Math.max(1, ...rows.map(r => r.total));
  if (!rows.length) return <p className="report-empty">Sem conversas neste período.</p>;
  return <><div className="report-legend"><span><i className="done"/>Concluídas</span><span><i className="active"/>Em atendimento</span><span><i className="pending"/>Pendentes / outras</span></div><div className="report-stacks">{rows.map(row => <div className="report-stack-row" key={row.name}><span>{channelNames[row.name] || row.name}</span><div className="report-stack-track"><div className="report-stack" style={{ width: `${row.total / max * 100}%` }} title={`${number(row.total)} conversas`}><i className="done" style={{ width: `${row.completed / row.total * 100}%` }}/><i className="active" style={{ width: `${row.active / row.total * 100}%` }}/><i className="pending" style={{ width: `${row.pending / row.total * 100}%` }}/></div></div><b>{number(row.total)}</b></div>)}</div><div className="report-table-scroll"><table><thead><tr><th>Canal</th><th>Concluídas</th><th>Em atendimento</th><th>Outras</th><th>Total</th></tr></thead><tbody>{rows.map(r => <tr key={r.name}><td>{channelNames[r.name] || r.name}</td><td>{number(r.completed)}</td><td>{number(r.active)}</td><td>{number(r.pending)}</td><td>{number(r.total)}</td></tr>)}</tbody></table></div></>;
}
function Bars({ rows, format = number, empty = 'Sem dados neste recorte.' }) {
  const max = Math.max(1, ...rows.map(r => r.value || 0));
  if (!rows.some(r => r.value)) return <p className="report-empty">{empty}</p>;
  return <div className="report-bars">{rows.map((row, i) => <div className="report-bar-row" key={row.id || `${row.name}-${i}`}><span title={row.name}>{row.name}</span><div className="report-bar-track"><div style={{ width: `${Math.max(0, row.value || 0) / max * 100}%`, background: row.color || 'var(--report-blue)' }}/></div><b>{format(row.value || 0)}</b></div>)}</div>;
}

export default function Report({ workspace, workspaces, onSwitch, onLogout }) {
  const [month, setMonth] = useState(monthNow);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState('todos');
  const [scope, setScope] = useState('');
  const [panelId, setPanelId] = useState('');
  useEffect(() => { document.title = 'Relatório de Atendimento e Vendas · FolkSales'; return () => { document.title = 'FolkSales — agenda, automações e resultados'; }; }, []);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const result = await request(`/workspaces/${workspace.id}/report?month=${month}`);
        if (alive) { setData(result); setError(''); setLoading(false); }
      } catch (e) { if (alive) { setError(e.message); setLoading(false); } }
    }
    setLoading(true); setData(null); load();
    const interval = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(interval); };
  }, [workspace.id, month]);

  const model = useMemo(() => {
    if (!data) return null;
    const panel = data.panels.find(p => p.id === panelId) || data.panels[0] || { id: '', name: '', steps: [] };
    const allCards = data.cardsByPanel[panel.id] || [];
    const sessionsById = new Map(data.sessions.map(s => [s.id, s]));
    const agentsById = new Map(data.agents.map(a => [a.id, a]));
    const teamName = new Map(data.departments.map(d => [d.id, d.name]));
    const agentName = new Map(data.agents.map(a => [a.id, a.name]));
    const cardTeam = card => teamForCard(card, sessionsById, agentsById);
    const sessions = data.sessions.filter(s => level === 'todos' || !scope || (level === 'equipes' ? (s.departmentId || 'none') === scope : (s.userId || 'none') === scope));
    const cards = allCards.filter(c => level === 'todos' || !scope || (level === 'equipes' ? (cardTeam(c) || 'none') === scope : (c.userId || 'none') === scope));
    const summary = summarize(sessions, cards, { ...panel, month });
    const peers = level === 'atendentes' || level === 'equipes' && scope ? [
      ...data.agents.map(a => ({ id: a.id, name: a.name })),
      { id: 'none', name: 'Chatbot / sem atendente' }
    ].filter(a => level !== 'equipes' || !scope || data.sessions.some(s => (s.departmentId || 'none') === scope && (s.userId || 'none') === a.id))
      : [...data.departments.map(d => ({ id: d.id, name: d.name })), { id: 'none', name: 'Sem equipe' }];
    const peerRows = peers.map(p => {
      const group = data.sessions.filter(s => (level === 'atendentes' || level === 'equipes' && scope ? (s.userId || 'none') === p.id && (level !== 'equipes' || !scope || (s.departmentId || 'none') === scope) : (s.departmentId || 'none') === p.id));
      const result = summarize(group, [], { ...panel, month });
      return { ...p, ...result };
    }).filter(p => p.total).sort((a, b) => b.total - a.total);
    const options = level === 'equipes' ? [...data.departments.map(d => ({ id: d.id, name: d.name })), { id: 'none', name: 'Sem equipe' }]
      : [...data.agents.map(a => ({ id: a.id, name: a.name })), { id: 'none', name: 'Chatbot / sem atendente' }];
    const filteredOptions = options.filter(o => data.sessions.some(s => (level === 'equipes' ? s.departmentId : s.userId) === (o.id === 'none' ? null : o.id)));
    const label = level === 'todos' || !scope ? workspace.name : level === 'equipes' ? teamName.get(scope) || 'Sem equipe' : agentName.get(scope) || 'Chatbot / sem atendente';
    return { panel, allCards, summary, peerRows, options: filteredOptions, label };
  }, [data, panelId, level, scope, month, workspace.name]);

  return <main className="report"><div className="report-wrap">
    <header className="report-header"><div><a className="report-brand" href={`/?workspace=${encodeURIComponent(workspace.id)}`} aria-label="FolkSales">Folk<span>Sales</span></a><span className="report-eyebrow">RESULTADOS · HELENA CRM</span><h1>Relatório de Atendimento e Vendas</h1><p>Dados do Helena CRM · fuso de Manaus (UTC−4)</p></div><div className="report-header-right"><nav aria-label="Navegação principal"><a href={`/?workspace=${encodeURIComponent(workspace.id)}`}>Agenda</a><a href={`/relatorios?workspace=${encodeURIComponent(workspace.id)}`} aria-current="page">Relatórios</a><a href={`/?workspace=${encodeURIComponent(workspace.id)}&section=automations`}>Automações</a><a href={`/?workspace=${encodeURIComponent(workspace.id)}&section=integrations`}>Integrações</a></nav><button onClick={onLogout}>Sair</button></div></header>
    <div className="report-controls"><label>Workspace<select value={workspace.id} onChange={e => onSwitch(e.target.value)}>{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>Período<input aria-label="Mês do relatório" type="month" value={month} onChange={e => setMonth(e.target.value)} max={monthNow()}/></label>{data && <label>Painel de vendas<select value={model?.panel.id || ''} onChange={e => setPanelId(e.target.value)}><option value="">{data.panels.length ? 'Selecione o painel' : 'Nenhum painel de vendas'}</option>{data.panels.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</div>
    {error && <div className="report-alert" role="alert">{error}</div>}
    {loading && !data && <p className="report-loading">Carregando dados do Helena…</p>}
    {data && model && <>
      <div className="report-status"><span>{data.syncError ? `Falha na última sincronização: ${data.syncError}` : 'Sincronização automática a cada 15 minutos'}</span><span>Atualizado em {new Date(data.updatedAt).toLocaleString('pt-BR', { timeZone: 'America/Manaus' })}</span></div>
      <div className="report-levels"><span>Nível</span>{[['todos', 'Todos'], ['equipes', 'Equipes'], ['atendentes', 'Atendentes']].map(([key, title]) => <button key={key} aria-pressed={level === key} onClick={() => { setLevel(key); setScope(''); }}>{title}</button>)}</div>
      {level !== 'todos' && <div className="report-scopes"><button aria-pressed={!scope} onClick={() => setScope('')}>{level === 'equipes' ? 'Todas as equipes' : 'Todos os atendentes'}</button>{model.options.map(o => <button key={o.id} aria-pressed={scope === o.id} onClick={() => setScope(o.id)}>{o.name}</button>)}</div>}
      <p className="report-crumb">Recorte atual: <strong>{model.label}</strong> · {number(model.summary.total)} conversas</p>
      <div className="report-kpis"><Kpi hero label="Conversas iniciadas" value={number(model.summary.total)} detail={level === 'todos' && data.previousTotal ? `${percent((model.summary.total - data.previousTotal) / data.previousTotal)} vs. mês anterior (${number(data.previousTotal)})` : 'Criadas no período selecionado'}/><Kpi label="Tempo médio de espera" value={duration(model.summary.wait)} detail={`${number(model.summary.waitCount)} conversas com tempo informado`}/><Kpi label="Tempo médio de atendimento" value={duration(model.summary.service)} detail={`${number(model.summary.serviceCount)} conversas com tempo informado`}/><Kpi label="Taxa de conclusão" value={percent(model.summary.completed)} detail="Status atual: concluída"/><Kpi label="1ª resposta em até 5 min" value={percent(model.summary.first)} detail={`${number(model.summary.firstCount)} conversas com horário informado`}/></div>
      <Card title="Conversas por dia" subtitle={`Volume diário · ${model.label}`} source="GET /chat/v2/session · createdAt"><LineChart values={model.summary.daily} month={month}/></Card>
      <div className="report-two"><Card title="Conversas por canal e status" subtitle={`Distribuição do volume · ${model.label}`} source="GET /chat/v2/session · channelType, status"><StackedChart rows={model.summary.channels}/></Card><Card title={level === 'atendentes' || level === 'equipes' && scope ? 'Espera média por atendente' : 'Espera média por equipe'} subtitle="Média apenas de conversas com timeWait informado" source="GET /chat/v2/session · timeWait, departmentId, userId"><Bars rows={model.peerRows.filter(p => p.wait != null).map(p => ({ id: p.id, name: p.name, value: p.wait, color: scope === p.id ? 'var(--report-orange)' : undefined }))} format={duration}/></Card></div>
      <div className="report-two"><Card title="Funil comercial" subtitle={`Cards abertos por etapa · ${model.panel.name || 'sem painel'}`} source="GET /crm/v2/panel/card · stepId, status"><Bars rows={model.summary.steps.map(s => ({ id: s.id, name: s.name, value: s.count }))} empty="Este recorte não tem cards abertos no painel de vendas."/></Card><Card title="Motivos de perda" subtitle={`${number(model.summary.lost)} cards perdidos · ${model.label}`} source="GET /crm/v2/panel/card · lostReason"><Bars rows={model.summary.reasons.map(r => ({ name: r.name, value: r.count, color: 'var(--report-orange)' }))} empty="Este recorte não tem cards perdidos."/></Card></div>
      <div className="report-kpis report-sales"><Kpi label="Negócios ganhos" value={number(model.summary.won)} detail={`de ${number(model.summary.cards)} cards criados no período`}/><Kpi label="Receita ganha" value={money(model.summary.revenue)} detail="Soma do valor dos cards ganhos"/><Kpi label="Ticket médio" value={money(model.summary.ticket)} detail="Receita ÷ negócios ganhos"/><Kpi label="Taxa de conversão" value={percent(model.summary.conversion)} detail="Ganhos ÷ cards criados"/><Kpi label="Cards em atraso" value={number(model.summary.overdue)} detail="isOverdue = true"/></div>
      <Card title={level === 'atendentes' || level === 'equipes' && scope ? 'Detalhamento por atendente' : 'Detalhamento por equipe'} subtitle="Ordenado por volume de conversas" source="GET /chat/v2/session + GET /core/v2/department + GET /core/v1/agent"><div className="report-table-scroll"><table><thead><tr><th>{level === 'atendentes' || level === 'equipes' && scope ? 'Atendente' : 'Equipe'}</th><th>Conversas</th><th>Espera méd.</th><th>Atend. méd.</th><th>1ª resp. ≤5min</th><th>Concluídas</th><th>Base espera</th></tr></thead><tbody>{model.peerRows.map(p => <tr key={p.id}><td>{p.name}</td><td>{number(p.total)}</td><td>{duration(p.wait)}</td><td>{duration(p.service)}</td><td>{percent(p.first)}</td><td>{percent(p.completed)}</td><td>{number(p.waitCount)}</td></tr>)}</tbody></table></div></Card>
      <p className="report-note"><strong>Como ler este relatório.</strong> As conversas e os cards foram criados no mês selecionado; status e responsáveis refletem o estado atual no Helena. Uma transferência atribui a conversa à equipe e ao atendente atuais. Cards com atendente em várias equipes só entram no recorte de equipe se houver uma conversa vinculada que indique a equipe. Os tempos e a taxa de primeira resposta usam apenas registros com o campo informado. O funil mostra os cards ainda abertos em cada etapa.</p>
    </>}
  </div></main>;
}
