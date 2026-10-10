'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, dt, jt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const SOURCES = ['manual', 'sirup', 'spse', 'lpse', 'bumn_portal', 'private_portal', 'vendor_portal', 'email', 'tender_radar'];

function Tenders() {
  const me = useMe();
  const sp = useSearchParams();
  const [filter, setFilter] = useState(sp.get('due') ? 'due' : 'active');
  const [q, setQ] = useState('');
  const [panel, setPanel] = useState<'' | 'new' | 'import'>('');
  const qs = filter === 'active' ? 'active=true' : filter === 'due' ? 'dueDays=7' : filter === 'relevant' ? 'minRelevance=60' : '';
  const { data, error, loading, reload } = useApi(`/api/v1/tenders?${qs}&q=${encodeURIComponent(q)}`, [qs, q]);
  const customers = useApi(panel === 'new' ? '/api/v1/customers?limit=100' : null, [panel]);
  const [f, setF] = useState<any>({ title: '', procuringEntity: '', source: 'manual', sourceRef: '', sourceUrl: '', hpsValue: '', submissionDeadline: '', customerId: '' });
  const [json, setJson] = useState('');
  const [importRes, setImportRes] = useState<any>(null);
  const act = useAction();
  const canWrite = me?.permissions.includes('tender.write');

  const create = (e: React.FormEvent) => { e.preventDefault(); act.run(async () => {
    const body: any = { ...f, hpsValue: f.hpsValue ? Number(f.hpsValue) : undefined, submissionDeadline: f.submissionDeadline ? new Date(f.submissionDeadline).toISOString() : undefined };
    for (const k of Object.keys(body)) if (body[k] === '' || body[k] === undefined) delete body[k];
    await api('/api/v1/tenders', { body }); setPanel(''); reload();
  }); };
  const doImport = () => act.run(async () => {
    let items;
    try { items = JSON.parse(json); } catch { throw new Error('JSON tidak valid'); }
    setImportRes(await api('/api/v1/tenders/import', { body: { items: Array.isArray(items) ? items : items.items } })); reload();
  });

  return (
    <>
      <PageHead title="Tender Center" sub="Discovery dari sumber sah, bid/no-bid, kesiapan dokumen, dan award"
        actions={canWrite && <><button className="btn sec sm" onClick={() => setPanel(panel === 'import' ? '' : 'import')}>Impor</button>
          <button className="btn pur sm" onClick={() => setPanel(panel === 'new' ? '' : 'new')}>+ Tender</button></>} />
      <ErrorBox error={act.error} />
      {panel === 'new' && (
        <form className="card" onSubmit={create}>
          <h2>Registrasi tender / RFQ</h2>
          <div className="grid g2">
            <Field label="Judul paket *"><input required minLength={5} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Instansi / perusahaan pengadaan *"><input required value={f.procuringEntity} onChange={(e) => setF({ ...f, procuringEntity: e.target.value })} /></Field>
            <Field label="Customer (opsional, wajib sebelum registrasi)"><select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}>
              <option value="">—</option>{customers.data?.items.map((c: any) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></Field>
            <Field label="Sumber"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{SOURCES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Kode RUP / ID paket"><input value={f.sourceRef} onChange={(e) => setF({ ...f, sourceRef: e.target.value })} /></Field>
            <Field label="URL sumber"><input type="url" value={f.sourceUrl} onChange={(e) => setF({ ...f, sourceUrl: e.target.value })} /></Field>
            <Field label="HPS / pagu (Rp)"><input type="number" min={0} value={f.hpsValue} onChange={(e) => setF({ ...f, hpsValue: e.target.value })} /></Field>
            <Field label="Batas submission"><input type="datetime-local" value={f.submissionDeadline} onChange={(e) => setF({ ...f, submissionDeadline: e.target.value })} /></Field>
          </div>
          <button className="btn" disabled={act.busy}>Simpan</button>
        </form>
      )}
      {panel === 'import' && (
        <div className="card">
          <h2>Impor tender (JSON)</h2>
          <p className="sub">Tempel ekspor dari Cyber Tender Radar / SiRUP / portal pengadaan. Hanya sumber publik atau akun sah; sistem tidak melewati CAPTCHA/login portal. Tender dengan relevansi rendah dan duplikat dilewati otomatis.</p>
          <textarea className="mono" style={{ minHeight: 160 }} value={json} placeholder='[{"title":"Jasa SOC 2026","procuringEntity":"Dinas X","source":"sirup","sourceRef":"12345","hpsValue":1500000000,"submissionDeadline":"2026-11-01T10:00:00+07:00"}]' onChange={(e) => setJson(e.target.value)} />
          <button className="btn" style={{ marginTop: 8 }} disabled={act.busy || !json} onClick={doImport}>Impor</button>
          {importRes && <div className="alert ok" style={{ marginTop: 8 }}>Dibuat {importRes.created.length} · duplikat {importRes.duplicates.length} · tidak relevan {importRes.skippedIrrelevant.length}</div>}
        </div>
      )}
      <div className="tabs">{[['active', 'Aktif'], ['due', 'Deadline ≤ 7 hari'], ['relevant', 'Relevansi ≥ 60'], ['all', 'Semua']].map(([k, l]) =>
        <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
      <ErrorBox error={error} />
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 10 }}><input placeholder="Cari judul / instansi / kode…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari tender" /></div>
        {loading ? <div style={{ padding: 10 }}><Loading /></div> : data?.items.length ? data.items.map((t: any) => (
          <Link key={t.id} href={`/tenders/${t.id}`} className="list-item">
            <div className="row"><b>{t.title}</b><span className="spacer" /><Badge s={t.status} /></div>
            <div className="sub">{t.code} · {t.procuringEntity} · HPS {jt(t.hpsValue ?? t.estimatedValue)} · relevansi {t.relevanceScore ?? '—'}
              {t.matchedKeywords?.length ? ` (${t.matchedKeywords.join(', ')})` : ''} · {t.requirementCount} persyaratan</div>
            <div className="row" style={{ marginTop: 4 }}>
              {t.submissionDeadline && <span className={`badge ${t.hoursLeft !== null && t.hoursLeft < 72 && t.hoursLeft >= 0 ? 'bad' : ''}`}>Deadline {dt(t.submissionDeadline)}{t.hoursLeft !== null && t.hoursLeft >= 0 ? ` · ${t.hoursLeft} jam` : ''}</span>}
              <span className="badge">{t.source}</span><span className="badge">{t.classification}</span>
            </div>
          </Link>)) : <div className="empty">Tidak ada tender</div>}
      </div>
    </>
  );
}
export default function Page() { return <Suspense fallback={<Loading />}><Tenders /></Suspense>; }
