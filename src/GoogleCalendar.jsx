import React,{useEffect,useState} from 'react';
import {CalendarDays,Check,ExternalLink,Unlink} from 'lucide-react';
export default function GoogleCalendar({api,workspaceId}){
 const [status,setStatus]=useState(null),[error,setError]=useState('');
 const load=()=>api('/google').then(setStatus).catch(e=>setError(e.message));
 useEffect(()=>{load();},[]);
 if(!status)return null;
 const connect=()=>api('/google/connect').then(({url})=>{location.href=url;}).catch(e=>setError(e.message));
 return <section className="automation-intro" style={{marginBottom:16}}><span className="stat-icon green"><CalendarDays size={24}/></span><div style={{flex:1}}><h3>Google Calendar</h3><p>{status.connected?<>Conectado à conta {status.account_email||'Google'}; novos eventos serão criados com o convidado informado.</>: 'Conecte o Google Calendar da Set92 para sincronizar novos eventos.'}</p>{error&&<small className="form-error">{error}</small>}</div>{status.connected?<><span className="badge"><Check size={13}/> Conectado</span><button className="outline" onClick={()=>api('/google',{method:'DELETE'}).then(load)}><Unlink size={14}/> Desconectar</button></>:<button className="primary" onClick={connect}><ExternalLink size={14}/> Conectar Google</button>}</section>;
}
