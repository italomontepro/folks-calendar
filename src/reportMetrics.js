const zone = 'America/Manaus';

export function dayOf(iso) {
  return Number(new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: zone }).format(new Date(iso)));
}

export function teamForCard(card, sessionsById, agentsById) {
  const linked = card.sessionId && sessionsById.get(card.sessionId);
  if (linked?.departmentId) return linked.departmentId;
  const departments = agentsById.get(card.userId)?.departments || [];
  return departments.length === 1 ? departments[0] : null;
}

export function summarize(sessions, cards, panel) {
  const validWait = sessions.filter(s => Number.isFinite(s.waitSeconds));
  const validService = sessions.filter(s => Number.isFinite(s.serviceSeconds));
  const validFirst = sessions.filter(s => Number.isFinite(s.firstSeconds));
  const avg = (list, key) => list.length ? list.reduce((sum, item) => sum + item[key], 0) / list.length : null;
  const completed = sessions.filter(s => s.status === 'COMPLETED').length;
  const won = cards.filter(c => c.status === 'WON');
  const lost = cards.filter(c => c.status === 'LOST');
  const revenue = won.reduce((sum, card) => sum + (Number(card.amount) || 0), 0);
  const [year, month] = panel.month.split('-').map(Number);
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const daily = Array.from({ length: dayCount }, () => 0);
  const channels = new Map();
  for (const session of sessions) {
    const day = dayOf(session.createdAt);
    if (day >= 1 && day <= dayCount) daily[day - 1]++;
    const name = session.channel || 'UNKNOWN';
    const row = channels.get(name) || { name, completed: 0, active: 0, pending: 0, total: 0 };
    row.total++;
    if (session.status === 'COMPLETED') row.completed++;
    else if (['STARTED', 'IN_PROGRESS'].includes(session.status)) row.active++;
    else row.pending++;
    channels.set(name, row);
  }
  const steps = panel.steps.map(step => ({ ...step, count: cards.filter(c => c.stepId === step.id && c.status === 'OPEN').length }));
  const reasons = [...lost.reduce((map, card) => {
    const name = card.lostReason || 'Não informado';
    map.set(name, (map.get(name) || 0) + 1);
    return map;
  }, new Map())].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    total: sessions.length, wait: avg(validWait, 'waitSeconds'), waitCount: validWait.length,
    service: avg(validService, 'serviceSeconds'), serviceCount: validService.length,
    first: validFirst.length ? validFirst.filter(s => s.firstSeconds <= 300).length / validFirst.length : null,
    firstCount: validFirst.length, completed: sessions.length ? completed / sessions.length : null,
    daily, channels: [...channels.values()].sort((a, b) => b.total - a.total),
    steps, reasons, cards: cards.length, won: won.length, lost: lost.length, revenue,
    ticket: won.length ? revenue / won.length : null,
    conversion: cards.length ? won.length / cards.length : null,
    overdue: cards.filter(c => c.isOverdue || c.overdue).length
  };
}
