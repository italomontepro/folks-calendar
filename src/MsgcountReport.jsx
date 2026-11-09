import React,{useState,useEffect} from 'react';

const pad=h=>String(h).padStart(2,'0')+':00';

// Atendimentos por equipe: modelo com botão enviado nos horários
// configurados; o clique responde com a contagem do período desde o horário anterior.
export default function MsgcountReport({api,channels,onRefresh}) {
 const [config,setConfig]=useState(null),[recipients,setRecipients]=useState(''),[hours,setHours]=useState(''),[groups,setGroups]=useState(''),[models,setModels]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 useEffect(()=>{let current=true;api('/helena/msgcount').then(c=>{if(!current)return;setConfig({...c,channelId:c.channelId||channels.find(ch=>ch.number.endsWith('981586710'))?.id||''});setRecipients(c.recipients.join('\n'));setHours(c.hours.join(', '));setGroups(c.groups.join('\n'));}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[channels]);
 useEffect(()=>{let current=true;setModels([]);if(!config?.channelId)return;api('/helena/templates?channelId='+encodeURIComponent(config.channelId)).then(list=>{if(!current)return;setModels(list);setConfig(c=>c.templateId||!list.length?c:{...c,templateId:list.find(m=>/att_quantidade_de_msg/.test(m.name))?.id||''});}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};},[config?.channelId]);
 async function act(fn){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}}
 if(!config)return null;
 const body=()=>JSON.stringify({...config,recipients,hours:hours.split(/[\s,;]+/).filter(Boolean),groups});
 const saved=c=>{setConfig(c);setRecipients(c.recipients.join('\n'));setHours(c.hours.join(', '));setGroups(c.groups.join('\n'));};
 return <form className="helena-editor helena-report" onSubmit={e=>{e.preventDefault();act(async()=>{const c=await api('/helena/msgcount',{method:'PUT',body:body()});saved(c);setNotice(c.enabled?`Ativo: modelo enviado às ${c.hours.map(pad).join(', ')} (Manaus).`:'Configuração salva. O envio está pausado.');});}}>
  <h3>Atendimentos por equipe</h3>
  <p className="form-hint">Nos horários abaixo, o FolkSales envia o modelo escolhido para cada número. Ao clicar em “{config.button}”, a pessoa recebe quantos atendimentos cada equipe recebeu desde o horário anterior, com o total por grupo.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="success-message" role="status">{notice}</p>}
  <div className="form-row"><label>Canal de WhatsApp<select value={config.channelId} onChange={e=>setConfig(c=>({...c,channelId:e.target.value,templateId:''}))}><option value="">Selecione</option>{channels.map(c=><option key={c.id} value={c.id}>{c.name} · {c.number}</option>)}</select></label>
  <label>Modelo<select value={config.templateId} onChange={e=>setConfig(c=>({...c,templateId:e.target.value}))}><option value="">Selecione</option>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div>
  <div className="form-row"><label>Texto do botão<input value={config.button} maxLength={40} onChange={e=>setConfig(c=>({...c,button:e.target.value}))}/></label>
  <label>Horários de envio (Manaus)<input value={hours} onChange={e=>setHours(e.target.value)} placeholder="7, 14, 22"/></label></div>
  <div className="form-row"><label>WhatsApp dos destinatários (um por linha, com DDI e DDD)<textarea rows={5} value={recipients} onChange={e=>setRecipients(e.target.value)} placeholder={'5592984532273'}/></label>
  <label>Grupos (parte do nome das equipes, um por linha)<textarea rows={5} value={groups} onChange={e=>setGroups(e.target.value)}/></label></div>
  <label className="inline-check"><input type="checkbox" checked={config.enabled} onChange={e=>setConfig(c=>({...c,enabled:e.target.checked}))}/>Envio automático ativo</label>
  <div className="form-footer"><button type="button" className="outline" disabled={busy||!config.recipients.length} onClick={()=>act(async()=>{const r=await api('/helena/msgcount/send',{method:'POST'});setNotice(`Modelo enviado agora para ${r.count} número(s). O clique responde com o período do último horário.`);await onRefresh();})}>Enviar agora</button><button className="primary" disabled={busy}>{busy?'Salvando…':'Salvar'}</button></div>
 </form>;
}
