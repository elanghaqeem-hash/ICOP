'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import SlaEditor from '@/components/SlaEditor';
import { ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
const DAYS = [[1,'Sen'],[2,'Sel'],[3,'Rab'],[4,'Kam'],[5,'Jum'],[6,'Sab'],[7,'Min']] as const;

export default function HelpdeskSettings(){
 const me=useMe(),isAdmin=!!me?.permissions.includes('integration.admin');
 const sla=useApi('/api/v1/helpdesk/sla');
 const holidays=useApi('/api/v1/helpdesk/holidays');
 const act=useAction();
 const [cal,setCal]=useState<{start:string;end:string;weekdays:number[]}|null>(null);
 const [h,setH]=useState({day:'',name:''}),[message,setMessage]=useState('');
 useEffect(()=>{if(sla.data&&!cal)setCal({
   start:sla.data.businessHours.start,end:sla.data.businessHours.end,weekdays:sla.data.businessHours.weekdays,
 });},[sla.data]);
 if(sla.loading||!sla.data||!cal)return <><ErrorBox error={sla.error}/><Loading/></>;
 const toggle=(d:number)=>setCal({...cal,weekdays:cal.weekdays.includes(d)?
   cal.weekdays.filter(x=>x!==d):[...cal.weekdays,d].sort()});
 return <>
   <PageHead title="Pengaturan SLA" crumbs={<Link href="/helpdesk">Helpdesk</Link>}
     sub="Asia/Jakarta · urutan SLA: klausul kontrak, tenant, kemudian default"/>
   <ErrorBox error={act.error}/>
   {message&&<div className="alert ok">{message}</div>}
   <div className="card">
     <h2>Target respons & resolusi</h2>
     <p className="sub">24x7 dihitung setiap menit. Kalender Jam Kerja tidak menghitung akhir pekan atau hari libur. Status WAITING_CUSTOMER menjeda batas resolusi.</p>
     <SlaEditor initial={sla.data.items} endpoint="/api/v1/helpdesk/sla" mode="tenant"
       canEdit={isAdmin} onSaved={sla.reload}/>
   </div>
   <div className="card">
     <h2>Jam kerja</h2>
     <div className="grid g3">
       <Field label="Mulai"><input type="time" disabled={!isAdmin} value={cal.start}
         onChange={e=>setCal({...cal,start:e.target.value})}/></Field>
       <Field label="Selesai"><input type="time" disabled={!isAdmin} value={cal.end}
         onChange={e=>setCal({...cal,end:e.target.value})}/></Field>
     </div>
     <div className="row" style={{marginBottom:8}}>
       {DAYS.map(([d,label])=><label key={d} className="check">
         <input type="checkbox" disabled={!isAdmin} checked={cal.weekdays.includes(d)}
           onChange={()=>toggle(d)}/> {label}</label>)}
     </div>
     {isAdmin&&<button className="btn" disabled={act.busy||!cal.weekdays.length}
       onClick={()=>act.run(async()=>{
         await api('/api/v1/helpdesk/calendar',{method:'PUT',body:cal});
         setMessage('Jam kerja disimpan');sla.reload();
       })}>Simpan jam kerja</button>}
   </div>
   <div className="card">
     <h2>Hari libur & cuti bersama</h2>
     <p className="sub">Masukkan hari libur nasional dan cuti bersama sesuai kalender resmi yang berlaku. Data tidak otomatis dinyatakan sah sebelum dicek administrator.</p>
     <div className="table-wrap"><table className="t">
       <thead><tr><th>Tanggal</th><th>Keterangan</th>{isAdmin&&<th/>}</tr></thead>
       <tbody>{holidays.data?.items.map((v:any)=><tr key={v.day}>
         <td className="mono">{v.day}</td><td>{v.name}</td>
         {isAdmin&&<td><button className="btn sec sm" disabled={act.busy}
            onClick={()=>act.run(async()=>{await api(`/api/v1/helpdesk/holidays/${v.day}`,{method:'DELETE'});holidays.reload();})}>Hapus</button></td>}
       </tr>)}
       {!holidays.data?.items.length&&<tr><td colSpan={3} className="empty">Belum ada hari libur.</td></tr>}
       </tbody></table></div>
     {isAdmin&&<div className="grid g3" style={{marginTop:8}}>
       <Field label="Tanggal"><input type="date" value={h.day} onChange={e=>setH({...h,day:e.target.value})}/></Field>
       <Field label="Keterangan"><input value={h.name} onChange={e=>setH({...h,name:e.target.value})}/></Field>
       <div style={{alignSelf:'end'}}><button className="btn" disabled={act.busy||!h.day||h.name.trim().length<3}
         onClick={()=>act.run(async()=>{await api('/api/v1/helpdesk/holidays',{body:h});
           setH({day:'',name:''});holidays.reload();})}>Tambah hari libur</button></div>
     </div>}
   </div>
 </>;
}
