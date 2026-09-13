export const triggers = ['event.created','event.updated','event.deleted','event.reminder','event.started'];
export function eventInput(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('Informe um título de até 200 caracteres.');
  const start = new Date(input.start), end = new Date(input.end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw new Error('O término deve ser posterior ao início.');
  const result = {title:input.title.trim(),start:start.toISOString(),end:end.toISOString(),allDay:!!input.allDay};
  for (const key of ['description','location','contact','email']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('Campo inválido: '+key);
    result[key] = (input[key] || '').slice(0,5000);
  }
  result.category = ['meeting','task','personal'].includes(input.category) ? input.category : 'meeting';
  result.reminder = Number(input.reminder ?? 15);
  if (![0,5,15,30,60,1440].includes(result.reminder)) throw new Error('Lembrete inválido.');
  return result;
}
export function hookInput(input) {
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Use uma URL HTTPS pública na porta 443.');
  if (!input.name?.trim() || input.name.length > 100) throw new Error('Informe o nome da automação.');
  if (!Array.isArray(input.triggers) || !input.triggers.length || input.triggers.some(t=>!triggers.includes(t))) throw new Error('Escolha pelo menos um gatilho válido.');
  return {name:input.name.trim(),url:url.href,triggers:[...new Set(input.triggers)],enabled:input.enabled !== false};
}
