'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBox, Loading, useAction, useApi } from '@/components/ui';

type Brief = {
  source: string;
  deadlines: { submissionWib: string | null; daysToSubmission: number | null; passed: boolean };
  requirements: { total: number; mandatory: number; highRiskOpen: number;
    mandatoryOpen: { ref: string; category: string; requirement: string; status: string; risk: string }[] };
  readiness: { percent: number; blockers: string[] };
  documents: { n: number; textReady: number };
  actions: { priority: string; text: string }[];
};
type SearchResult = {
  grounded: boolean; mode: string; message: string; disclaimer?: string;
  sources: { n: number; kind: string; title: string; ref: string; excerpt: string; link: string; score: number }[];
};

export default function TenderEvidenceAssistant({tenderId}:{tenderId:string}) {
  const {data,error,loading,reload}=useApi(`/api/v1/tenders/${tenderId}/assistant/brief`);
  const [question,setQuestion]=useState('');
  const [result,setResult]=useState<SearchResult | null>(null);
  const act=useAction();
  const ask=()=>act.run(async()=>{
    const response=await api<SearchResult>(`/api/v1/tenders/${tenderId}/assistant/search`,{body:{question}});
    setResult(response);
  });
  const brief=data as Brief|null;
  return <div className="grid g2">
    <div className="card">
      <h2>Brief kesiapan tender</h2>
      <p className="sub">Dihitung dari database tender, bukan kesimpulan AI. Tetap harus diperiksa terhadap RKS dan addendum.</p>
      <ErrorBox error={error}/>
      {loading?<Loading/>:brief&&<>
        <div className="grid g3">
          <div><div className="sub">Readiness</div><b>{brief.readiness.percent}%</b></div>
          <div><div className="sub">Persyaratan wajib terbuka</div><b>{brief.requirements.mandatoryOpen.length}</b></div>
          <div><div className="sub">Risiko tinggi terbuka</div><b>{brief.requirements.highRiskOpen}</b></div>
        </div>
        <p className="sub">Deadline: {brief.deadlines.submissionWib??'Belum ditentukan'} {brief.deadlines.daysToSubmission!==null
          ? `· ${brief.deadlines.daysToSubmission} hari`:''}</p>
        <h3>Langkah prioritas</h3>
        {!brief.actions.length&&<div className="alert ok">Tidak ada tindakan otomatis yang teridentifikasi. Tetap lakukan review manual.</div>}
        {brief.actions.map((a,i)=><div className={a.priority==='HIGH'?'alert warn':'step'} key={i}>
          <b>{a.priority}</b> · {a.text}
        </div>)}
        {brief.requirements.mandatoryOpen.length>0&&<>
          <h3 style={{marginTop:16}}>Persyaratan wajib belum siap</h3>
          {brief.requirements.mandatoryOpen.map((r,i)=><div className="step" key={i}>
            <b>{r.ref}</b> · {r.status} · {r.requirement}
          </div>)}
        </>}
        <button className="btn sec" type="button" onClick={reload}>Muat ulang brief</button>
      </>}
    </div>
    <div className="card">
      <h2>Cari bukti dari RKS & aanwijzing</h2>
      <p className="sub">Pencarian kata kunci terbatas pada tender ini. Hasil berupa cuplikan, bukan jawaban atau keputusan kepatuhan AI.</p>
      <ErrorBox error={act.error}/>
      <label htmlFor="tender-evidence-query" className="sub">Pertanyaan / kata kunci</label>
      <textarea id="tender-evidence-query" rows={3} style={{width:'100%'}} value={question}
        onChange={e=>setQuestion(e.target.value)} placeholder="Contoh: berapa SLA layanan SOC atau syarat sertifikasi tim?"/>
      <div className="row">
        <button className="btn" type="button" disabled={act.busy||question.trim().length<5}
          onClick={ask}>{act.busy?'Mencari…':'Cari sumber'}</button>
        <span className="sub">Mode: keyword (tanpa pgvector)</span>
      </div>
      {result&&<>
        <div className={result.grounded?'alert ok':'alert warn'}>{result.message}</div>
        {result.sources.map(x=><div className="step" key={x.n}>
          <div><b>[{x.n}] {x.title}</b> <span className="sub">{x.kind} · {x.ref}</span></div>
          <p style={{whiteSpace:'pre-wrap'}}>{x.excerpt}</p>
        </div>)}
        {result.disclaimer&&<p className="sub">{result.disclaimer}</p>}
      </>}
    </div>
  </div>;
}
