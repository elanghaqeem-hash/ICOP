'use client';
import {useState} from 'react';
import {api,dt} from '@/lib/api';
import {Badge,ErrorBox,Loading,useAction,useApi,useMe} from '@/components/ui';

type S={
 id:string;requirementId:string;refCode:string;category:string;requirement:string;
 currentStatus:string;suggestedStatus:string;verified:boolean;downgraded:boolean;
 evidenceText:string|null;evidenceQuote:string|null;rationale:string;
 provider:string|null;createdBy:string;createdAt:string;
};
export default function TenderComplianceReview({tenderId,afterDecision}:{
 tenderId:string;afterDecision?:()=>void;
}){
 const me=useMe();
 const canSuggest=!!me?.permissions.includes('tender.write')&&!!me?.permissions.includes('ai.use');
 const canDecide=!!me?.permissions.includes('tender.write');
 const endpoint=`/api/v1/tenders/${tenderId}/assistant/suggestions`;
 const {data,error,loading,reload}=useApi(endpoint);
 const run=useAction();
 const [message,setMessage]=useState('');
 const [note,setNote]=useState('');
 const create=()=>run.run(async()=>{
  const r=await api(`/api/v1/tenders/${tenderId}/assistant/compliance-suggest`,{body:{}});
  setMessage(`${r.created} saran dibuat; ${r.downgraded} diturunkan karena bukti tidak terverifikasi. Belum ada persyaratan yang diubah.`);
  reload();
 });
 const decide=(sid:string,decision:'ACCEPT'|'REJECT')=>run.run(async()=>{
  const r=await api(`/api/v1/tenders/${tenderId}/assistant/suggestions/${sid}/decide`,{
    body:{decision,note:note.trim()||undefined},
  });
  setMessage(decision==='ACCEPT'?`Keputusan ditinjau dan diterapkan oleh reviewer. Status: ${r.requirementStatus}`:
    'Saran ditolak. Compliance matrix tetap sesuai status sebelumnya.');
  setNote('');reload();afterDecision?.();
 });
 return <div className="card">
   <h2>Saran kepatuhan AI — wajib review manusia</h2>
   <p className="sub">AI hanya membandingkan persyaratan administratif, kualifikasi, dan teknis dengan fakta perusahaan VERIFIED yang masih berlaku. Harga/komersial tidak dinilai. Hasil bukan keputusan final dan tidak otomatis mengubah compliance matrix.</p>
   <ErrorBox error={error}/><ErrorBox error={run.error}/>
   {message&&<div className="alert ok">{message}</div>}
   {canSuggest&&<button type="button" className="btn pur" disabled={run.busy}
     onClick={create}>{run.busy?'Memproses…':'Buat saran berdasarkan bukti VERIFIED'}</button>}
   {loading?<Loading/>:<>
     <p className="sub" style={{marginTop:10}}>Menunggu keputusan: <strong>{data?.items?.length??0}</strong> · Persetujuan wajib dilakukan petugas yang berbeda dari pengaju.</p>
     {(data?.items??[] as S[]).map((s:S)=>{
      const canReview=canDecide&&s.createdBy!==me?.id;
      return <div className="step" key={s.id} style={{display:'block',marginBottom:12}}>
       <div className="row"><b>{s.refCode}</b><span className="sub">{s.category}</span>
         <Badge s={s.suggestedStatus}/></div>
       <p>{s.requirement}</p>
       <div className="sub">Saat ini: {s.currentStatus} → Usulan: {s.suggestedStatus} · {dt(s.createdAt)}</div>
       {s.downgraded&&<div className="alert warn">Status usulan diturunkan ke CLARIFY karena tidak memiliki kutipan fakta terverifikasi.</div>}
       <p>{s.rationale}</p>
       {s.verified&&s.evidenceQuote?<div className="alert">
          <strong>Bukti terverifikasi</strong>
          <p>{s.evidenceText??'Bukti tidak tersedia'}</p>
          <p style={{whiteSpace:'pre-wrap'}}>“{s.evidenceQuote}”</p>
       </div>:<p className="sub">Belum ada kutipan bukti terverifikasi. Diperlukan pengecekan manual.</p>}
       {canReview?<div className="row" style={{marginTop:8}}>
         <button className="btn ok sm" disabled={run.busy} onClick={()=>decide(s.id,'ACCEPT')}>Terima setelah verifikasi</button>
         <button className="btn bad sm" disabled={run.busy} onClick={()=>decide(s.id,'REJECT')}>Tolak saran</button>
       </div>:<p className="sub">Diajukan pengguna ini atau Anda tidak memiliki wewenang review.</p>}
      </div>;
     })}
     {!data?.items?.length&&<p className="sub">Belum ada saran yang perlu direview.</p>}
   </>}
   {canDecide&&<label className="sub" htmlFor="tender-review-note">Catatan keputusan (opsional)</label>}
   {canDecide&&<textarea id="tender-review-note" rows={2} style={{width:'100%'}} maxLength={500}
     value={note} onChange={e=>setNote(e.target.value)} placeholder="Alasan menerima/menolak dan validasi bukti..."/>}
 </div>;
}
