'use client';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Field, useApi, useMe } from './ui';

const FEATURES: [string, string][] = [
  ['opportunity_brief', 'Ringkasan opportunity & next best action'],
  ['scoping_gap', 'Gap informasi scoping & pertanyaan klarifikasi'],
  ['quotation_cover', 'Draft paragraf pembuka surat penawaran'],
  ['rks_summary', 'Ringkas RKS/KAK (tempel teks)'],
  ['chat', 'Tanya bebas (Sales Assistant)'],
];

export default function AiBox({ opportunityId }: { opportunityId?: string }) {
  const me = useMe();
  const [feature, setFeature] = useState(opportunityId ? 'opportunity_brief' : 'chat');
  const [prompt, setPrompt] = useState('');
  const [doc, setDoc] = useState('');
  const [out, setOut] = useState<any>(null);
  const [err, setErr] = useState<{ msg: string; attempts?: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const feats = useApi('/api/v1/ai/features');
  if (!me?.permissions.includes('ai.use')) return null;
  const enabled = (k: string) => feats.data?.items.find((f: any) => f.feature === k)?.effective !== false;
  const options = FEATURES.filter(([k]) => enabled(k));
  if (feats.data && !options.length) return <div className="card"><h2>AI Assistant</h2><div className="alert info">Fitur AI dinonaktifkan oleh admin.</div></div>;
  const go = async () => {
    setBusy(true); setErr(null); setOut(null);
    try { setOut(await api('/api/v1/ai/complete', { body: { feature, prompt, opportunityId, document: doc || undefined } })); }
    catch (e) { setErr({ msg: (e as Error).message, attempts: e instanceof ApiError ? (e.details as any[]) : undefined }); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>AI Assistant</h2>
      <p className="sub">Data dikirim ke provider AI setelah redaksi (email, NPWP, IP, telepon, rahasia). Biaya & margin internal tidak pernah dikirim. Output = draft yang wajib ditinjau.</p>
      <Field label="Tugas"><select value={feature} onChange={(e) => setFeature(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {feature === 'rks_summary' && <Field label="Teks RKS/KAK"><textarea value={doc} onChange={(e) => setDoc(e.target.value)} style={{ minHeight: 140 }} /></Field>}
      <Field label="Instruksi tambahan (opsional)"><textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
      <button className="btn pur" disabled={busy} onClick={go}>{busy ? 'Memproses…' : 'Jalankan'}</button>
      {err && <div className="alert bad" style={{ marginTop: 10 }}>{err.msg}
        {Array.isArray(err.attempts) && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{err.attempts.map((a: any, i: number) => <li key={i}>{a.provider}: {a.skipped ?? a.error}</li>)}</ul>}</div>}
      {out && (
        <div style={{ marginTop: 10 }}>
          <div className="row sub" style={{ marginBottom: 6 }}>
            <span className="badge pur">{out.provider} · {out.model}</span>
            {out.attempts.length > 1 && <span className="badge warn">failover {out.attempts.filter((a: any) => !a.ok).map((a: any) => a.provider).join(' → ')}</span>}
            {out.redactions > 0 && <span className="badge">{out.redactions} data diredaksi</span>}
          </div>
          <div className="ai-out">{out.text}</div>
          <div className="row" style={{ marginTop: 6 }}><button className="btn sec sm" onClick={() => navigator.clipboard?.writeText(out.text)}>Salin</button><span className="sub">{out.disclaimer}</span></div>
        </div>
      )}
    </div>
  );
}
