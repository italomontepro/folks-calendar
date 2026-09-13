import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { createHmac } from 'node:crypto';
export async function deliver(url, payload, secret) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) throw new Error('Destino não permitido');
  const hostname = target.hostname.replace(/^\[|\]$/g,'');
  const records = await lookup(hostname,{all:true});
  if (!records.length || records.some(r=>ipaddr.process(r.address).range() !== 'unicast')) throw new Error('Endereços privados ou reservados não são permitidos');
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now()/1000));
  const signature = createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
  return new Promise((resolve,reject)=>{
    const request = https.request(target,{method:'POST',lookup:(_host, options, cb)=>options.all ? cb(null,[records[0]]) : cb(null,records[0].address,records[0].family),headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'X-Folks-Signature':`t=${timestamp},v1=${signature}`,'X-Folks-Delivery':payload.id}},response=>{
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.statusCode);
      else reject(new Error(`HTTP ${response.statusCode}`));
    });
    const timeout = setTimeout(()=>request.destroy(new Error('Tempo limite de 10 segundos')),10000);
    request.on('close',()=>clearTimeout(timeout)); request.on('error',reject); request.end(body);
  });
}
