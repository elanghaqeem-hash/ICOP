'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, apiDownload, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const KINDS: [string, string][] = [['SUMMARY', 'Ringkasan eksekutif'], ['RISKS', 'Kewajiban, tenggat, denda & risiko'], ['EXTRACT', 'Ekstraksi data terstruktur'], ['QA', 'Tanya-jawab dokumen']];
const FEAT: Record<string, string> = { SUMMARY: 'document_summary', RISKS: 'document_risks', EXTRACT: 'document_extract', QA: 'document_qa' };
const mb = (n: number | null) => (n == null ? '—' : `${(n / 1048576).toFixed(2)} MB`);

export default function DocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data, error, loading, reload } = useApi(`/api/v1/documents/${id}`);
  const feats = useApi('/api/v1/ai/features');
  const [page, setPage] = useState<any>(null);
  const [kind, setKind] = useState('SUMMARY');
  const [question, setQuestion] = useState('');
  const [fields, setFields] = useState('nilai_kontrak, tanggal_mulai, jangka_waktu, denda_keterlambatan, sla_respons');
  const [range, setRange] = useState({ from: '', to: '' });
  const [analysis, setAnalysis] = useState<any>(null);
  const act = useAction();

  // Poll status pemrosesan & analisis
  useEffect(() => {
    if (!data) return;
    const busy = ['QUEUED', 'PROCESSING'].includes(data.document.status) || (analysis && ['QUEUED', 'RUNNING'].includes(analysis.status));
    if (!busy) return;
    const t = setTimeout(async () => {
      if (analysis && ['QUEUED', 'RUNNING'].includes(analysis.status)) setAnalysis(await api(`/api/v1/documents/${id}/analyses/${analysis.id}`).catch(() => analysis));
      reload();
    }, 2500);
    return () => clearTimeout(t);
  }, [data, analysis, id, reload]);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const d = data.document;
  const enabled = (k: string) => feats.data?.items.find((f: any) => f.feature === FEAT[k])?.effective !== false;
  const run = () => act.run(async () => {
    const body: any = { kind };
    if (kind === 'QA') body.question = question;
    if (kind === 'EXTRACT') body.fields = fields.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name: name.replace(/[^a-zA-Z0-9_]/g, '_') }));
    if (range.from || range.to) body.range = { from: range.from ? Number(range.from) : undefined, to: range.to ? Number(range.to) : undefined };
    const r = await api(`/api/v1/documents/${id}/analyses`, { body });
    setAnalysis({ id: r.id, kind, status: 'QUEUED' }); reload();
  });
  const open = (aid: string) => act.run(async () => setAnalysis(await api(`/api/v1/documents/${id}/analyses/${aid}`)));
  const res = analysis?.result;
  return (
    <>
      <PageHead crumbs={<Link href="/documents">Document Center</Link>} title={d.title} sub={`${d.filename} · ${d.uploadedByName} · ${dt(d.createdAt)}`} actions={<Badge s={d.status} />} />
      <ErrorBox error={act.error} />
      {d.processingNote && <div className={`alert ${d.status === 'FAILED' ? 'bad' : 'info'}`}>{d.processingNote}</div>}
      {data.job?.progress?.step === 'ocr' && d.status === 'PROCESSING' && <div className="alert info">OCR {data.job.progress.done}/{data.job.progress.total} halaman…</div>}
      <div className="grid g4">
        <div className="card kpi"><div className="l">Halaman</div><div className="v">{d.pageCount ?? '—'}</div></div>
        <div className="card kpi"><div className="l">Sumber teks</div><div className="v" style={{ fontSize: '1rem' }}>{d.textSource ?? '—'}{d.ocrPages ? ` · OCR ${d.ocrPages}` : ''}</div>{d.ocrConfidence != null && <div className="sub">confidence {d.ocrConfidence}%</div>}</div>
        <div className="card kpi"><div className="l">Ukuran</div><div className="v" style={{ fontSize: '1rem' }}>{mb(d.sizeOriginal)}{d.sizeStored ? ` → ${mb(d.sizeStored)}` : ''}</div>{d.compression && <div className="sub">{d.compression.method} · {d.compression.ratio}%{d.compression.lossy ? ' (lossy)' : ''}</div>}</div>
        <div className="card kpi"><div className="l">Kerahasiaan</div><div className="v" style={{ fontSize: '1rem' }}>{d.confidentiality}</div></div>
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/documents/${id}/file?variant=compressed`, d.filename))}>Unduh (terkompresi)</button>
        <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/documents/${id}/file?variant=original`, d.filename))}>Unduh asli</button>
        {me?.permissions.includes('documents.write') && ['READY', 'FAILED'].includes(d.status) && <button className="btn sec sm" onClick={() => act.run(async () => { await api(`/api/v1/documents/${id}/reprocess`, { body: { ocr: 'force' } }); reload(); })}>OCR ulang semua halaman</button>}
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Halaman</h3>
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {data.pages.map((p: any) => (
              <button key={p.pageNo} className="list-item" style={{ width: '100%', textAlign: 'left', border: 'none', background: page?.pageNo === p.pageNo ? 'var(--purple-soft)' : 'transparent', cursor: 'pointer' }}
                onClick={() => act.run(async () => setPage(await api(`/api/v1/documents/${id}/pages/${p.pageNo}`)))}>
                <div className="row"><b>Hal. {p.pageNo}</b><span className={`badge ${p.source === 'OCR' ? 'warn' : ''}`}>{p.source}{p.confidence != null ? ` ${p.confidence}%` : ''}</span><span className="sub">{p.chars} karakter</span></div>
                <div className="sub">{p.preview}</div>
              </button>))}
          </div>
          {page && <div className="ai-out" style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>{page.text || '(kosong)'}</div>}
        </div>
        <div className="card">
          <h3>Analisis AI</h3>
          {d.confidentiality === 'RESTRICTED' ? <div className="alert warn">Dokumen RESTRICTED tidak dikirim ke penyedia AI.</div> : d.status !== 'READY' ? <div className="sub">Tersedia setelah dokumen siap.</div> : (
            <>
              <Field label="Jenis analisis"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.filter(([k]) => enabled(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
              {kind === 'QA' && <Field label="Pertanyaan"><textarea value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>}
              {kind === 'EXTRACT' && <Field label="Field (pisahkan koma)"><input value={fields} onChange={(e) => setFields(e.target.value)} /></Field>}
              <div className="row"><Field label="Dari hal."><input type="number" min={1} style={{ width: 90 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
                <Field label="Sampai hal."><input type="number" min={1} style={{ width: 90 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field></div>
              <button className="btn pur" disabled={act.busy || (kind === 'QA' && question.length < 5) || !enabled(kind)} onClick={run}>Jalankan analisis</button>
            </>
          )}
          {data.analyses.length > 0 && <div style={{ marginTop: 10 }}>{data.analyses.map((a: any) => (
            <div key={a.id} className="step"><Badge s={a.status} /><button className="btn sec sm" onClick={() => open(a.id)}>{a.kind}</button><span className="sub">{a.question ?? ''} · {dt(a.createdAt)}</span></div>))}</div>}
        </div>
      </div>
      {analysis && (
        <div className="card">
          <div className="row"><h2 style={{ margin: 0 }}>Hasil {analysis.kind}</h2><Badge s={analysis.status} />{analysis.progress?.total ? <span className="sub">{analysis.progress.done}/{analysis.progress.total} bagian</span> : null}</div>
          {analysis.error && <div className="alert bad">{analysis.error}</div>}
          {analysis.providers?.length > 0 && <div className="sub">AI: {[...new Set(analysis.providers)].join(', ')} · draft wajib ditinjau manusia</div>}
          {res && analysis.kind === 'SUMMARY' && <><div className="ai-out" style={{ marginTop: 8 }}>{res.summary}</div>
            {analysis.verification?.invalidPageRefs?.length > 0 && <div className="alert warn">Rujukan halaman tidak valid: {analysis.verification.invalidPageRefs.join(', ')}</div>}</>}
          {res && analysis.kind === 'RISKS' && <>
            <p className="sub">{analysis.verification.accepted} temuan terverifikasi · {analysis.verification.rejectedUnverified} ditolak (kutipan tidak ditemukan di dokumen)</p>
            <div className="table-wrap"><table className="t"><thead><tr><th>Kategori</th><th>Temuan</th><th>Hal.</th></tr></thead><tbody>
              {res.items.map((it: any, i: number) => <tr key={i}><td><span className={`badge ${['HIGH', 'CRITICAL'].includes(it.severity) ? 'bad' : 'warn'}`}>{it.severity}</span> {it.category}</td><td>{it.statement}<div className="sub">“{it.quote}”</div></td><td>{it.page}</td></tr>)}
            </tbody></table></div></>}
          {res && analysis.kind === 'EXTRACT' && <div className="table-wrap"><table className="t"><tbody>
            {Object.entries(res.fields).map(([k, v]: any) => <tr key={k}><td className="mono">{k}</td><td>{v ? <><b>{String(v.value)}</b><div className="sub">hal. {v.page} — “{v.quote}”</div></> : <span className="sub">tidak ditemukan</span>}</td></tr>)}
          </tbody></table></div>}
          {res && analysis.kind === 'QA' && <>
            <div className={`alert ${analysis.verification.grounded ? 'ok' : 'warn'}`}>{analysis.verification.grounded ? `${analysis.verification.verifiedCitations} sitasi terverifikasi` : analysis.verification.note ?? 'Tidak ada sitasi'}</div>
            <div className="ai-out">{res.answer}</div>
            {res.citations?.map((c: any, i: number) => <div key={i} className="sub" style={{ marginTop: 4 }}>{c.verified ? '✓' : '✗'} hal. {c.page ?? '?'} — “{c.quote}”</div>)}</>}
        </div>
      )}
    </>
  );
}
