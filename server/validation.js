export const emailList = value => [...new Set((value || '').split(/[,;]/).map(e => e.trim()).filter(Boolean))];
export const triggers = ['event.created','event.updated','event.deleted','event.reminder','event.started'];
export function eventInput(input) {
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw new Error('Informe um título de até 200 caracteres.');
  const start = new Date(input.start), end = new Date(input.end);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) throw new Error('O término deve ser posterior ao início.');
  const result = {title:input.title.trim(),start:start.toISOString(),end:end.toISOString(),allDay:!!input.allDay};
  for (const key of ['description','location','contact','email','contactName','phone','assigneeName','assigneePhone']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('Campo inválido: '+key);
    result[key] = (input[key] || '').slice(0,5000);
  }
  const emails = emailList(result.email);
  if (emails.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new Error('Informe e-mails válidos separados por vírgula para convidar no Google Calendar.');
  result.email = emails.join(', ');
  if (!result.location) result.location = 'A confirmar';
  result.phone = result.phone.replace(/[\s()+.-]/g, '');
  if (result.phone && !/^[1-9]\d{9,14}$/.test(result.phone)) throw new Error('Informe o WhatsApp com código do país e DDD.');
  result.assigneePhone=result.assigneePhone.replace(/[\s()+.-]/g,'');
  if(result.assigneePhone && !/^[1-9]\d{9,14}$/.test(result.assigneePhone)) throw new Error('WhatsApp do responsável inválido. Use código do país e DDD.');
  result.messagesEnabled = input.messagesEnabled !== false;
  result.category = ['meeting','task','personal'].includes(input.category) ? input.category : 'meeting';
  result.reminder = Number(input.reminder ?? 15);
  if (![0,5,15,30,60,120,1440].includes(result.reminder)) throw new Error('Lembrete inválido.');
  return result;
}
export function hookInput(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new Error('Informe o nome da automação.');
  if (!Array.isArray(input.triggers) || !input.triggers.length || input.triggers.some(t=>!triggers.includes(t))) throw new Error('Escolha pelo menos um gatilho válido.');
  const kind = input.kind || 'webhook';
  if (!['webhook','helena'].includes(kind)) throw new Error('Tipo de automação inválido.');
  const common = {kind,name:input.name.trim(),triggers:[...new Set(input.triggers)],enabled:input.enabled !== false};
  if (kind === 'helena') {
    if (typeof input.channelId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.channelId)) throw new Error('Selecione o canal e o modelo aprovado.');
    // HELENA template IDs are not always UUIDs. Imported Meta templates can
    // use a short slug such as "relatorio"; keep the field bounded and reject
    // control characters while allowing the identifier returned by the API.
    if (typeof input.templateId !== 'string' || !/^[^\u0000-\u001f\u007f]{1,200}$/.test(input.templateId.trim())) throw new Error('Selecione o canal e o modelo aprovado.');
    const timezone = input.timezone || 'America/Manaus';
    try { new Intl.DateTimeFormat('pt-BR',{timeZone:timezone}).format(); } catch { throw new Error('Fuso horário inválido.'); }
    const parameters = input.parameters || {};
    if (typeof parameters !== 'object' || Array.isArray(parameters) || Object.keys(parameters).length > 50) throw new Error('Variáveis inválidas.');
    for (const [key,value] of Object.entries(parameters)) {
      if (!key || key.length > 150 || ['__proto__','constructor','prototype'].includes(key) || typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Preencha as variáveis do modelo.');
      for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) if (!['responsavel','nome','titulo','data','hora','fim','local','descricao','email','contato','telefone'].includes(match[1])) throw new Error('Variável desconhecida: '+match[1]);
    }
    const categories = input.categories || [];
    if (!Array.isArray(categories) || categories.some(c=>!['meeting','task','personal'].includes(c))) throw new Error('Agenda inválida.');
    const fileIdOrUrl = input.fileIdOrUrl || '';
    if (typeof fileIdOrUrl !== 'string' || fileIdOrUrl.length > 2000) throw new Error('Arquivo inválido.');
    if (fileIdOrUrl && !/^[a-f0-9-]{36}$/i.test(fileIdOrUrl)) { const url=new URL(fileIdOrUrl); if (url.protocol!=='https:' || url.username || url.password) throw new Error('Use uma URL HTTPS para o arquivo.'); }
    const recipient=input.recipient || 'contact';
    if(!['contact','assignee'].includes(recipient)) throw new Error('Destinatário inválido.');
    const reminderMinutes=Number(input.reminderMinutes ?? 1440);
    if(![5,15,30,60,120,1440].includes(reminderMinutes)) throw new Error('Antecedência inválida.');
    return {...common,recipient,reminderMinutes,channelId:input.channelId,templateId:input.templateId,timezone,parameters,categories:[...new Set(categories)],fileIdOrUrl};
  }
  const url = new URL(input.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Use uma URL HTTPS pública na porta 443.');
  return {...common,url:url.href};
}
