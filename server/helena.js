import { randomUUID, randomBytes } from 'node:crypto';
import { fail } from './security.js';

// Fixed origin: a workspace token is never forwarded to a user-supplied URL.
export async function helenaRequest(token, path, body, fetcher = fetch) {
  let response;
  try {
    response = await fetcher('https://api.wts.chat/chat/v1/' + path, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {})
    });
  } catch {
    throw Object.assign(new Error(body ? 'Resposta do HELENA não confirmada. Confira o atendimento antes de reenviar.' : 'Não foi possível conectar ao HELENA.'), {ambiguous:!!body});
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'Token do HELENA inválido ou sem permissão.' : response.status === 429 ? 'Limite de requisições do HELENA. Nova tentativa em breve.' : `HELENA retornou HTTP ${response.status}. Confira canal, modelo e parâmetros.`;
    throw Object.assign(new Error(message), {retryable:response.status===429, ambiguous:!!body && response.status>=500});
  }
  try { return await response.json(); }
  catch { throw Object.assign(new Error('Resposta inválida do HELENA. Confira o atendimento antes de reenviar.'), {ambiguous:!!body}); }
}
async function helenaPut(token, path, body) {
  const response = await fetch('https://api.wts.chat/chat/v1/' + path, {
    method:'PUT', redirect:'error', signal:AbortSignal.timeout(20000),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HELENA retornou HTTP ${response.status}.`);
  return response.json();
}
export const getIntegration = (db, workspaceId) => db.prepare('SELECT * FROM integrations WHERE workspace_id=?').get(workspaceId);
export async function channels(token, request = helenaRequest) {
  const result = await request(token,'channel?ChannelType=Whatsapp');
  if (!Array.isArray(result)) throw new Error('Lista de canais inválida.');
  return result.filter(c=>c.active && c.number && ['CLOUDAPI_WHATSAPP','DIALOG360_WHATSAPP'].includes(c.type?.toUpperCase())).map(c=>({id:c.id,number:c.number.replace(/[^0-9]/g,''),name:c.identity?.displayName || c.numberFormatted || c.number}));
}
export async function templates(token, channelId, request = helenaRequest) {
  const result=[];
  for(let page=1;page<=100;page++) {
    const data=await request(token,`template?ChannelId=${encodeURIComponent(channelId)}&ApprovedOnly=true&Archived=false&IncludeDetails=All&PageSize=100&PageNumber=${page}`);
    if (!Array.isArray(data.items)) throw new Error('Lista de modelos inválida.');
    result.push(...data.items.filter(t=>t.active && !t.archived && t.status?.toUpperCase()==='APPROVED' && t.channelId===channelId).map(t=>({id:t.id,name:t.name,text:t.text,params:t.params || [],fileType:t.fileType})));
    if (!data.hasMorePages && !(data.totalPages>page)) return result;
  }
  throw new Error('Há muitos modelos. Reduza os modelos ativos no canal.');
}
export async function validateHelenaHook(db, workspaceId, hook) {
  if (hook.kind !== 'helena') return hook;
  const integration = getIntegration(db,workspaceId);
  if (!integration) fail(400,'Conecte o HELENA deste workspace primeiro.');
  const channel=(await channels(integration.token)).find(c=>c.id===hook.channelId);
  if (!channel) fail(400,'Canal oficial ativo não encontrado nesta conta.');
  const template=(await templates(integration.token,channel.id)).find(t=>t.id===hook.templateId);
  if (!template) fail(400,'Modelo aprovado não encontrado neste canal.');
  for (const param of template.params) if (param.name && !hook.parameters[param.name]?.trim()) fail(400,'Preencha a variável '+param.name);
  const names=new Set(template.params.map(p=>p.name));
  if(Object.keys(hook.parameters).some(p=>!names.has(p))) fail(400,'O modelo mudou. Selecione-o novamente para atualizar as variáveis.');
  if (template.fileType && template.fileType!=='UNDEFINED' && !hook.fileIdOrUrl) fail(400,'Este modelo exige um arquivo. Informe a URL HTTPS ou o ID.');
  return {...hook,from:channel.number,channelName:channel.name,templateName:template.name,templateText:template.text,integrationRevision:integration.revision};
}
export function templateBody(hook, event, deliveryId) {
  const phone=hook.recipient==='assignee'?event.assigneePhone:event.phone;
  if (!/^[1-9]\d{9,14}$/.test(phone || '')) throw new Error('Evento sem WhatsApp válido com código do país e DDD.');
  const start=new Date(event.start),end=new Date(event.end),options={timeZone:hook.timezone};
  const values={nome:event.contactName,responsavel:event.assigneeName,titulo:event.title,data:start.toLocaleDateString('pt-BR',options),hora:start.toLocaleTimeString('pt-BR',{...options,hour:'2-digit',minute:'2-digit'}),fim:end.toLocaleTimeString('pt-BR',{...options,hour:'2-digit',minute:'2-digit'}),local:event.location || 'Não informado',descricao:event.description || 'Não informado',email:event.email || 'Não informado',contato:event.contact || 'Não informado',telefone:event.phone};
  const parameters=Object.fromEntries(Object.entries(hook.parameters || {}).map(([key,value])=>[key,value.replace(/\{\{([^{}]+)\}\}/g,(_,name)=>{
    if (!values[name]) throw new Error(`Preencha ${name} no evento para enviar este modelo.`);
    return values[name];
  })]));
  return {from:hook.from,to:phone,templateId:hook.templateId,parameters,senderId:deliveryId,...(hook.fileIdOrUrl?{fileIdOrUrl:hook.fileIdOrUrl}:{})};
}
export function installHelena(app, store, base, admin) {
  const {db,transaction}=store;
  const integration = workspaceId => {const value=getIntegration(db,workspaceId);if(!value)fail(400,'Conecte o HELENA primeiro.');return value;};
  app.post('/api/helena/webhook/:secret', async (req,res) => {
    const integration=db.prepare('SELECT * FROM integrations WHERE webhook_secret=?').get(req.params.secret);
    if (!integration) return res.status(404).json({error:'Webhook não encontrado.'});
    res.json({ok:true});
    const body=req.body || {};
    if (body.eventType !== 'MESSAGE_RECEIVED') return;
    const strings=[];
    const walk=(value,key='')=>{if(value && typeof value==='object')for(const [k,v] of Object.entries(value))walk(v,k);else if(typeof value==='string')strings.push({key,value});};
    walk(body.content || body);
    const text=strings.map(x=>x.value).join(' ').toLowerCase();
    const find=(names, value=body.content || body, parent='')=>{if(!value || typeof value!=='object')return null;for(const [k,v] of Object.entries(value)){const lower=k.toLowerCase();if(names.includes(lower) && typeof v==='string')return v;if(lower==='id' && /session|conversation|atendimento/.test(parent) && typeof v==='string')return v;if(v&&typeof v==='object'){const found=find(names,v,lower);if(found)return found;}}return null;};
    const sessionId=find(['sessionid','session_id','session','conversationid','conversation']);
    const phone=(find(['phonenumber','phonenumberformatted','phone','to','contactphonenumber'])||'').replace(/[^0-9]/g,'');
    if (!sessionId) return;
    const workspaceId=integration.workspace_id;
    const events=store.all('events',workspaceId).filter(event=>{
      const eventPhone=(event.phone || '').replace(/[^0-9]/g,'');
      return eventPhone && phone && eventPhone===phone && Date.parse(event.start)>Date.now()-48*3600000;
    }).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
    try {
      if (/\b(remarcar|reagendar|alterar|mudar)\b/.test(text)) {
        await helenaPut(integration.token,`session/${encodeURIComponent(sessionId)}/transfer`,{type:'DEPARTMENT',newDepartmentId:integration.reschedule_department_id || '1f08f5c8-c4ae-4730-b820-871e7d8af275'});
      } else if (/\b(confirmar|confirmado|confirmo|sim)\b/.test(text) && events[0]) {
        const event=events[0];store.put('events',{...event,confirmationStatus:'confirmed',confirmedAt:new Date().toISOString()},workspaceId);
      }
    } catch (error) { console.error('HELENA webhook action:',error.message); }
  });
  app.get(base+'/helena',admin,(req,res)=>res.json({connected:!!getIntegration(db,req.workspaceId),webhookConfigured:!!getIntegration(db,req.workspaceId)?.webhook_secret}));
  app.put(base+'/helena',admin,async(req,res)=>{
    const token=typeof req.body.token==='string'?req.body.token.trim().replace(/^Bearer\s+/i,''):'';
    if(token.length<20 || token.length>4096 || /\s/.test(token)) fail(400,'Informe o token da conta HELENA.');
    const available=await channels(token);
    transaction(()=>{
      const old=getIntegration(db,req.workspaceId), secret=old?.webhook_secret || randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO integrations (workspace_id,token,revision,webhook_secret,reschedule_department_id) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET token=excluded.token,revision=excluded.revision,webhook_secret=COALESCE(integrations.webhook_secret,excluded.webhook_secret)').run(req.workspaceId,token,randomUUID(),secret,'1f08f5c8-c4ae-4730-b820-871e7d8af275');
      // A new account credential must never inherit active sends from the previous account.
      for(const hook of store.all('hooks',req.workspaceId).filter(h=>h.kind==='helena')) {
        store.put('hooks',{...hook,enabled:false},req.workspaceId);
        db.prepare("UPDATE jobs SET status='cancelled' WHERE workspace_id=? AND hook=? AND status='pending'").run(req.workspaceId,hook.id);
      }
    });
    const config=getIntegration(db,req.workspaceId), webhookUrl=`${req.protocol}://${req.get('host')}/api/helena/webhook/${config.webhook_secret}`;
    try { await helenaRequest(token,'webhook/subscription',{name:'Folks Calendar — respostas de agendamento',url:webhookUrl,enabled:true,events:['MESSAGE_RECEIVED']}); } catch (error) { console.error('HELENA webhook subscription:',error.message); }
    res.json({connected:true,channels:available});
  });
  app.delete(base+'/helena',admin,(req,res)=>{
    transaction(()=>{
      db.prepare('DELETE FROM integrations WHERE workspace_id=?').run(req.workspaceId);
      for(const hook of store.all('hooks',req.workspaceId).filter(h=>h.kind==='helena')) {
        store.put('hooks',{...hook,enabled:false},req.workspaceId);
        db.prepare("UPDATE jobs SET status='cancelled' WHERE workspace_id=? AND hook=? AND status='pending'").run(req.workspaceId,hook.id);
      }
    });res.json({connected:false});
  });
  app.get(base+'/helena/channels',admin,async(req,res)=>res.json(await channels(integration(req.workspaceId).token)));
  app.get(base+'/helena/templates',admin,async(req,res)=>{
    if(typeof req.query.channelId!=='string' || !/^[a-f0-9-]{36}$/i.test(req.query.channelId))fail(400,'Selecione um canal.');
    res.json(await templates(integration(req.workspaceId).token,req.query.channelId));
  });
  app.post(base+'/deliveries/:id/status',admin,async(req,res)=>{
    const job=db.prepare('SELECT * FROM jobs WHERE id=? AND workspace_id=?').get(req.params.id,req.workspaceId);
    if(!job?.provider_id)fail(404,'Envio do HELENA não encontrado.');
    const config=integration(req.workspaceId);
    if(config.revision!==job.integration_revision)fail(400,'A conexão do HELENA foi alterada desde este envio.');
    // The send endpoint reports acceptance; the message endpoint reports the
    // final Meta delivery result and includes the provider's failure reason.
    const result=await helenaRequest(config.token,'message/'+encodeURIComponent(job.provider_id));
    const status=result.status==='FAILED'?'failed':['DELIVERED','READ'].includes(result.status)?'delivered':'accepted';
    db.prepare('UPDATE jobs SET status=?,provider_status=?,error=? WHERE id=? AND workspace_id=?').run(status,result.status || 'UNKNOWN',result.status==='FAILED'?(result.failedReason || 'O HELENA informou falha no envio.') : null,job.id,req.workspaceId);
    res.json({status,providerStatus:result.status});
  });
}
