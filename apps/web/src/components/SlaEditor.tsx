'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBox, useAction } from '@/components/ui';

export type SlaRow = { priority: string; response: number; resolution: number; calendar: '24x7' | 'BUSINESS' };
const PRI = ['P1','P2','P3','P4'];
const defaults: Record<string, SlaRow> = {
 P1:{priority:'P1',response:15,resolution:240,calendar:'24x7'},
 P2:{priority:'P2',response:60,resolution:480,calendar:'24x7'},
 P3:{priority:'P3',response:240,resolution:1440,calendar:'BUSINESS'},
 P4:{priority:'P4',response:480,resolution:4320,calendar:'BUSINESS'},
};
const human=(m:number)=>m>=1440&&m%1440===0?`${m/1440} hari`:m>=60&&m%60===0?`${m/60} jam`:`${m} menit`;

export default function SlaEditor({initial,endpoint,mode,canEdit,onSaved}:{
 initial:SlaRow[]; endpoint:string; mode:'tenant'|'contract'; canEdit:boolean;onSaved?:()=>void;
}){
 const {busy,error,run}=useAction();
 const [rows,setRows]=useState<Record<string,SlaRow&{on:boolean}>>({});
 const [message,setMessage]=useState('');
 useEffect(()=>{
   const next:Record<string,SlaRow&{on:boolean}>={};
   for(const p of PRI){
     const r=initial.find(x=>x.priority===p);
     next[p]={...(r??defaults[p]),response:Number((r??defaults[p]).response),
       resolution:Number((r??defaults[p]).resolution),on:mode==='tenant'||!!r};
   }
   setRows(next);
 },[JSON.stringify(initial),mode]);
 const set=(p:string,k:string,v:unknown)=>setRows(prev=>({...prev,[p]:{...prev[p],[k]:v}}));
 const save=()=>run(async()=>{
   const items=PRI.map(p=>rows[p]).filter(r=>r.on).map(({on,...r})=>r);
   await api(endpoint,{method:'PUT',body:{items}});
   setMessage('SLA berhasil disimpan. Berlaku untuk tiket baru dan perubahan prioritas.');onSaved?.();
 });
 if(!rows.P1)return null;
 return <>
   <ErrorBox error={error}/>
   {message&&<div className="alert ok">{message}</div>}
   <div className="table-wrap"><table className="t"><thead><tr>
     {mode==='contract'&&<th>Klausul</th>}
     <th>Prioritas</th><th className="r">Respons (menit)</th>
     <th className="r">Resolusi (menit)</th><th>Kalender</th>
   </tr></thead><tbody>
   {PRI.map(p=>{const r=rows[p],disabled=!canEdit||!r.on;return <tr key={p}>
     {mode==='contract'&&<td><input type="checkbox" checked={r.on} disabled={!canEdit} aria-label={`Klausul ${p}`}
        onChange={e=>set(p,'on',e.target.checked)}/></td>}
     <td><b>{p}</b></td>
     <td className="r"><input type="number" min={1} style={{maxWidth:110}} disabled={disabled} value={r.response}
       onChange={e=>set(p,'response',Number(e.target.value))}/> <span className="sub">{human(r.response)}</span></td>
     <td className="r"><input type="number" min={1} style={{maxWidth:110}} disabled={disabled} value={r.resolution}
       onChange={e=>set(p,'resolution',Number(e.target.value))}/> <span className="sub">{human(r.resolution)}</span></td>
     <td><select value={r.calendar} disabled={disabled} onChange={e=>set(p,'calendar',e.target.value)}>
       <option value="24x7">24x7</option><option value="BUSINESS">Jam kerja</option>
     </select></td>
   </tr>})}
   </tbody></table></div>
   {canEdit&&<button className="btn" disabled={busy} onClick={save}>Simpan SLA</button>}
 </>;
}
