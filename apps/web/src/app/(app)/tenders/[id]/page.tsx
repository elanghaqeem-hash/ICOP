'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, apiDownload, apiUpload, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
import TenderEvidenceAssistant from '@/components/TenderEvidenceAssistant';

const KINDS = ['RKS', 'KAK', 'TOR', 'ADDENDUM', 'AANWIJZING_MOM', 'SUBMISSION_PROOF', 'EVALUATION', 'AWARD_LETTER', 'OTHER'];
const STATUSES = ['UNREVIEWED', 'COMPLY', 'PARTIAL', 'NON_COMPLY', 'NOT_APPLICABLE', 'CLARIFY'];
const CATS = ['ADMINISTRATIVE', 'QUALIFICATION', 'TECHNICAL', 'COMMERCIAL'];

export default function TenderWorkspace() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const { data, error, loading, reload } = useApi(`/api/v1/tenders/${id}`);
  const [tab, setTab] = useState('overview');
  const act = useAction();
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const t = data.tender;
  const r = data.readiness;
  const w = me?.permissions.includes('tender.write');
  const move = (to: string) => act.run(async () => {
    let note: string | undefined;
    if (['NO_BID', 'CANCELLED', 'LOST'].includes(to)) { note = window.prompt(`Alasan ${to} (wajib):`) ?? undefined; if (!note) return; }
    await api(`/api/v1/tenders/${id}/status`, { body: { to, note } }); reload();
  });
  const tabs: [string, string][] = [['overview', 'Ringkasan'], ['docs', `Dokumen (${data.documents.length})`], ['reqs', `Persyaratan (${data.requirements.length})`],
    ['assistant', 'Asisten Tender'], ['bid', 'Bid/No-Bid'], ['clar', `Klarifikasi (${data.clarifications.length})`], ['proposal', `Proposal (${data.proposals.length})`]];

  return (
    <>
      <PageHead crumbs={<Link href="/tenders">Tender Center</Link>} title={t.title}
        sub={<>{t.code} · {t.procuringEntity} · HPS {idr(t.hpsValue ?? t.estimatedValue)} · deadline {dt(t.submissionDeadline)}{data.customer ? <> · <Link href={`/customers/${data.customer.id}`}>{data.customer.legalName}</Link></> : ''}{t.opportunityId ? <> · <Link href={`/opportunities/${t.opportunityId}`}>opportunity</Link></> : ''}</>}
        actions={<Badge s={t.status} />} />
      <ErrorBox error={act.error} />
      {w && data.allowedTransitions.length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}><span className="sub">Pindah ke:</span>
          {data.allowedTransitions.map((s: string) => <button key={s} className={`btn sm ${['NO_BID', 'CANCELLED', 'LOST'].includes(s) ? 'bad' : ['AWARDED', 'APPROVED'].includes(s) ? 'ok' : 'sec'}`} disabled={act.busy} onClick={() => move(s)}>{s.replace(/_/g, ' ')}</button>)}
        </div>
      )}
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'overview' && (
        <div className="grid g2">
          <div className="card">
            <h3>Submission readiness</h3>
            <div className="row"><b style={{ fontSize: '1.4rem' }}>{r.percent}%</b><span className="sub">{r.mandatoryReady}/{r.mandatoryTotal} persyaratan wajib siap{r.hoursLeft !== null ? ` · ${r.hoursLeft} jam ke deadline` : ''}</span></div>
            {r.blockers.length ? r.blockers.map((b: string) => <div key={b} className="alert warn" style={{ margin: '6px 0' }}>{b}</div>) : <div className="alert ok" style={{ marginTop: 6 }}>Siap untuk persetujuan & submission</div>}
            <div className="table-wrap"><table className="t" style={{ marginTop: 6 }}><thead><tr><th>Kategori</th><th className="r">Total</th><th className="r">Comply</th><th className="r">Belum</th><th className="r">Non</th></tr></thead><tbody>
              {CATS.map((c) => <tr key={c}><td>{c}</td><td className="r">{r.byCategory[c].total}</td><td className="r">{r.byCategory[c].comply}</td><td className="r">{r.byCategory[c].unreviewed}</td><td className="r">{r.byCategory[c].nonComply}</td></tr>)}
            </tbody></table></div>
          </div>
          <div className="card">
            <h3>Detail</h3>
            <dl className="kv"><dt>Sumber</dt><dd>{t.source}{t.sourceRef ? ` · ${t.sourceRef}` : ''}{t.sourceUrl ? <> · <a href={t.sourceUrl} target="_blank" rel="noopener noreferrer">tautan</a></> : ''}</dd>
              <dt>Metode</dt><dd>{t.procurementMethod ?? '—'}</dd><dt>Relevansi</dt><dd>{t.relevanceScore} · {t.classification} {t.matchedKeywords?.join(', ')}</dd>
              <dt>Aanwijzing</dt><dd>{dt(t.aanwijzingAt)}</dd><dt>Pembukaan</dt><dd>{dt(t.openingAt)}</dd><dt>Kompetitor</dt><dd>{t.competitors?.join(', ') || '—'}</dd>
              {t.outcomeNote && <><dt>Catatan hasil</dt><dd>{t.outcomeNote}</dd></>}</dl>
          </div>
          <div className="card">
            <h3>Riwayat status</h3>
            {data.history.map((h: any) => <div key={h.id} className="step"><Badge s={h.toStatus} /><span className="sub">{dt(h.changedAt)} · {h.changedByName ?? 'sistem'}{h.note ? ` — ${h.note}` : ''}</span></div>)}
          </div>
          {!data.customer && w && <LinkCustomer tender={t} onDone={reload} />}
        </div>
      )}
      {tab === 'docs' && <Documents id={id} docs={data.documents} canWrite={!!w} onDone={reload} />}
      {tab === 'reqs' && <Requirements id={id} code={t.code} reqs={data.requirements} canWrite={!!w} onDone={reload} />}
      {tab === 'assistant' && <TenderEvidenceAssistant tenderId={id} />}
      {tab === 'bid' && <Bid id={id} data={data} canWrite={!!w} onDone={reload} />}
      {tab === 'clar' && <Clarifications id={id} items={data.clarifications} reqs={data.requirements} canWrite={!!w} onDone={reload} />}
      {tab === 'proposal' && (
        <div className="card" style={{ padding: 0 }}>
          {data.proposals.map((p: any) => <Link key={p.id} href={`/proposals/${p.id}`} className="list-item"><div className="row"><b className="mono">{p.number}</b><span className="spacer" /><Badge s={p.status} /></div><div className="sub">{p.title} · v{p.version} · {dt(p.updatedAt)}</div></Link>)}
          <div style={{ padding: 12 }}>
            {t.opportunityId && me?.permissions.includes('proposal.write')
              ? <button className="btn pur" disabled={act.busy} onClick={() => act.run(async () => { const p = await api('/api/v1/proposals', { body: { opportunityId: t.opportunityId, tenderId: id }, idempotencyKey: newKey() }); router.push(`/proposals/${p.id}`); })}>+ Generate proposal teknis dari data</button>
              : <div className="sub">Registrasikan tender (membuat opportunity) sebelum membuat proposal.</div>}
          </div>
        </div>
      )}
    </>
  );
}

function LinkCustomer({ tender, onDone }: { tender: any; onDone: () => void }) {
  const cs = useApi('/api/v1/customers?limit=100');
  const [cid, setCid] = useState('');
  const act = useAction();
  return (
    <div className="card">
      <h3>Hubungkan ke customer</h3>
      <p className="sub">Wajib sebelum REGISTERED — satu customer untuk seluruh tender, opportunity, dan kontrak.</p>
      <ErrorBox error={act.error} />
      <div className="row"><select style={{ flex: 1 }} value={cid} onChange={(e) => setCid(e.target.value)}><option value="">— pilih —</option>{cs.data?.items.map((c: any) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select>
        <button className="btn sm" disabled={!cid || act.busy} onClick={() => act.run(async () => { await api(`/api/v1/tenders/${tender.id}`, { method: 'PATCH', body: { customerId: cid, rowVersion: tender.rowVersion } }); onDone(); })}>Simpan</button></div>
    </div>
  );
}

function Documents({ id, docs, canWrite, onDone }: { id: string; docs: any[]; canWrite: boolean; onDone: () => void }) {
  const [kind, setKind] = useState('RKS');
  const [file, setFile] = useState<File | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [res, setRes] = useState<any>(null);
  const act = useAction();
  const upload = () => act.run(async () => {
    const fd = new FormData(); fd.append('kind', kind); fd.append('file', file!);
    await apiUpload(`/api/v1/tenders/${id}/documents`, fd); setFile(null); onDone();
  });
  return (
    <>
      {canWrite && (
        <div className="card">
          <h2>Unggah dokumen</h2>
          <ErrorBox error={act.error} />
          <div className="grid g3">
            <Field label="Jenis"><select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></Field>
            <Field label="File (PDF, DOCX, TXT; bukti boleh JPG/PNG; maks 20 MB)"><input type="file" accept=".pdf,.docx,.txt,image/*" capture={kind === 'SUBMISSION_PROOF' ? 'environment' : undefined} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          </div>
          <button className="btn" disabled={!file || act.busy} onClick={upload}>{act.busy ? 'Mengunggah…' : 'Unggah'}</button>
        </div>
      )}
      {res && <div className={`alert ${res.ai?.error ? 'warn' : 'ok'}`}>Rule-based {res.rule} · AI diterima {res.ai.accepted}, ditolak (kutipan tidak ditemukan) {res.ai.rejectedUnverified}{res.ai.error ? ` · ${res.ai.error}` : ''} → {res.added} persyaratan baru
        {res.addendumImpact?.length ? <div>Dampak addendum: {res.addendumImpact.map((x: any) => `${x.newRef}≈${x.existingRef}`).join(', ')}</div> : null}</div>}
      <div className="card" style={{ padding: 0 }}>
        {docs.length ? docs.map((d) => (
          <div key={d.id} className="list-item">
            <div className="row"><b>{d.kind}</b><span className="sub">v{d.version} · {d.filename}</span><span className="spacer" /><Badge s={d.extractionStatus} /></div>
            <div className="sub">{(d.sizeBytes / 1024).toFixed(0)} KB{d.pageCount ? ` · ${d.pageCount} halaman` : ''}{d.textLength ? ` · ${d.textLength} karakter` : ''} · {dt(d.createdAt)}</div>
            {d.extractionNote && <div className="alert warn" style={{ margin: '6px 0' }}>{d.extractionNote}</div>}
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/tenders/${id}/documents/${d.id}/file`, d.filename))}>Unduh</button>
              {canWrite && d.extractionStatus === 'DONE' && <>
                <label className="check" style={{ fontSize: '.8rem' }}><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> + AI</label>
                <button className="btn pur sm" disabled={act.busy} onClick={() => act.run(async () => { setRes(await api(`/api/v1/tenders/${id}/documents/${d.id}/extract`, { body: { useAi } })); onDone(); })}>Ekstrak persyaratan</button></>}
            </div>
          </div>)) : <div className="empty">Belum ada dokumen</div>}
      </div>
    </>
  );
}

function Requirements({ id, code, reqs, canWrite, onDone }: { id: string; code: string; reqs: any[]; canWrite: boolean; onDone: () => void }) {
  const [cat, setCat] = useState('');
  const [only, setOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<any>({});
  const [add, setAdd] = useState({ category: 'TECHNICAL', requirement: '', mandatory: true });
  const act = useAction();
  const list = reqs.filter((r) => (!cat || r.category === cat) && (!only || r.complianceStatus === 'UNREVIEWED' || r.complianceStatus === 'NON_COMPLY' || r.complianceStatus === 'CLARIFY'));
  const save = (r: any, patch: any) => act.run(async () => { await api(`/api/v1/tenders/${id}/requirements/${r.id}`, { method: 'PATCH', body: patch }); setOpen(null); onDone(); });
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="tabs" style={{ marginBottom: 0 }}>{['', ...CATS].map((c) => <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c || 'Semua'}</button>)}</div>
        <label className="check" style={{ fontSize: '.84rem' }}><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Perlu tindakan</label>
        <span className="spacer" />
        <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/tenders/${id}/compliance-matrix.csv`, `compliance-${code}.csv`))}>Ekspor CSV</button>
      </div>
      <ErrorBox error={act.error} />
      <div className="card" style={{ padding: 0 }}>
        {list.length ? list.map((r) => (
          <div key={r.id} className="list-item">
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <span className="mono">{r.refCode}</span>
              <span style={{ flex: 1, minWidth: 200 }}>{r.requirement}</span>
              <Badge s={r.complianceStatus} />
            </div>
            <div className="row sub" style={{ marginTop: 4 }}>
              <span className="badge">{r.category}</span>{r.mandatory ? <span className="badge bad">wajib</span> : <span className="badge">opsional</span>}
              <span className={`badge ${r.riskLevel === 'HIGH' ? 'bad' : r.riskLevel === 'LOW' ? '' : 'warn'}`}>risiko {r.riskLevel}</span>
              <span>{r.origin}{r.sourcePage ? ` · hal. ${r.sourcePage}` : ''}{r.picName ? ` · PIC ${r.picName}` : ''}</span>
              {canWrite && <button className="btn sec sm" onClick={() => { setOpen(open === r.id ? null : r.id); setEdit({ complianceStatus: r.complianceStatus, response: r.response ?? '', evidence: r.evidence ?? '' }); }}>{open === r.id ? 'Tutup' : 'Review'}</button>}
            </div>
            {r.response && open !== r.id && <div className="sub" style={{ marginTop: 4 }}>Tanggapan: {r.response}{r.evidence ? ` · Bukti: ${r.evidence}` : ''}</div>}
            {open === r.id && (
              <div style={{ marginTop: 8 }}>
                {r.sourceExcerpt && <div className="ai-out" style={{ marginBottom: 8 }}>“{r.sourceExcerpt}”</div>}
                <div className="grid g3">
                  <Field label="Status"><select value={edit.complianceStatus} onChange={(e) => setEdit({ ...edit, complianceStatus: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
                  <Field label="Tanggapan"><input value={edit.response} onChange={(e) => setEdit({ ...edit, response: e.target.value })} /></Field>
                  <Field label="Referensi bukti (wajib untuk admin/kualifikasi COMPLY)"><input value={edit.evidence} onChange={(e) => setEdit({ ...edit, evidence: e.target.value })} /></Field>
                </div>
                <button className="btn sm" disabled={act.busy} onClick={() => save(r, { complianceStatus: edit.complianceStatus, response: edit.response || undefined, evidence: edit.evidence || undefined })}>Simpan</button>
              </div>
            )}
          </div>)) : <div className="empty">Tidak ada persyaratan — unggah RKS/KAK lalu ekstrak</div>}
      </div>
      {canWrite && (
        <div className="card">
          <h3>Tambah persyaratan manual</h3>
          <div className="grid g3">
            <Field label="Kategori"><select value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></Field>
            <Field label="Persyaratan"><input value={add.requirement} onChange={(e) => setAdd({ ...add, requirement: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={add.mandatory} onChange={(e) => setAdd({ ...add, mandatory: e.target.checked })} /> Wajib</label>
          </div>
          <button className="btn sm" disabled={add.requirement.length < 5 || act.busy} onClick={() => act.run(async () => { await api(`/api/v1/tenders/${id}/requirements`, { body: add }); setAdd({ ...add, requirement: '' }); onDone(); })}>Tambah</button>
        </div>
      )}
    </>
  );
}

function Bid({ id, data, canWrite, onDone }: { id: string; data: any; canWrite: boolean; onDone: () => void }) {
  const [scores, setScores] = useState<Record<string, number>>(Object.fromEntries(data.criteria.map((c: any) => [c.key, 3])));
  const [coi, setCoi] = useState(false);
  const [conditions, setConditions] = useState('');
  const act = useAction();
  const weighted = Math.round(data.criteria.reduce((s: number, c: any) => s + (c.weight * (scores[c.key] - 1)) / 4, 0) * 10) / 10;
  const knock = data.criteria.some((c: any) => c.knockoutAt !== undefined && scores[c.key] <= c.knockoutAt) || coi;
  const rec = knock ? 'NO_GO' : weighted >= 70 ? 'GO' : weighted >= 50 ? 'CONDITIONAL_GO' : 'NO_GO';
  const can = canWrite && ['REGISTERED', 'BID_DECISION'].includes(data.tender.status);
  return (
    <>
      {data.bids.map((b: any) => (
        <div key={b.id} className="card">
          <div className="row"><Badge s={b.recommendation} /><b>{b.weightedScore}</b><Badge s={b.status} /><span className="sub">{b.createdByName} · {dt(b.createdAt)}</span></div>
          {b.knockouts?.length ? <div className="alert bad" style={{ marginTop: 6 }}>{b.knockouts.join('; ')}</div> : null}
          {b.conditions && <div className="sub">Syarat: {b.conditions}</div>}
        </div>
      ))}
      {can ? (
        <div className="card">
          <h2>Bid / No-Bid scorecard</h2>
          <ErrorBox error={act.error} />
          {data.criteria.map((c: any) => (
            <div key={c.key} className="field">
              <label>{c.label} (bobot {c.weight}){c.knockoutAt ? ' · knockout' : ''} — <span className="sub">{c.hint}</span></label>
              <div className="row">{[1, 2, 3, 4, 5].map((v) => <button key={v} type="button" className={`btn sm ${scores[c.key] === v ? '' : 'sec'}`} style={{ minWidth: 42 }} onClick={() => setScores({ ...scores, [c.key]: v })}>{v}</button>)}</div>
            </div>
          ))}
          <label className="check"><input type="checkbox" checked={coi} onChange={(e) => setCoi(e.target.checked)} /> Ada conflict of interest yang perlu dideklarasikan</label>
          {rec === 'CONDITIONAL_GO' && <Field label="Syarat Conditional Go (wajib)"><textarea value={conditions} onChange={(e) => setConditions(e.target.value)} /></Field>}
          <div className="alert info" style={{ marginTop: 8 }}>Skor {weighted} → <b>{rec.replace('_', ' ')}</b>. Keputusan final mengikuti DoA: Manager → VP{Number(data.tender.hpsValue ?? 0) > 1e9 ? ' → Direktur (> Rp1 M)' : ''}.</div>
          <button className="btn pur" disabled={act.busy} onClick={() => act.run(async () => {
            await api(`/api/v1/tenders/${id}/bid-assessment`, { body: { scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v }])), conflictOfInterest: coi, conditions: conditions || undefined }, idempotencyKey: newKey() });
            onDone();
          })}>Ajukan untuk approval</button>
        </div>
      ) : !data.bids.length && <div className="empty">Bid assessment tersedia setelah tender REGISTERED</div>}
    </>
  );
}

function Clarifications({ id, items, reqs, canWrite, onDone }: { id: string; items: any[]; reqs: any[]; canWrite: boolean; onDone: () => void }) {
  const [q, setQ] = useState('');
  const act = useAction();
  const ref = (rid: string) => reqs.find((r) => r.id === rid)?.refCode;
  return (
    <>
      <ErrorBox error={act.error} />
      {canWrite && <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn pur sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/api/v1/tenders/${id}/clarifications/ai-draft`, { body: {} }); onDone(); })}>Draft pertanyaan AI (status CLARIFY/PARTIAL)</button>
      </div>}
      <div className="card" style={{ padding: 0 }}>
        {items.length ? items.map((c) => (
          <div key={c.id} className="list-item">
            <div className="row"><span className="mono">{ref(c.requirementId) ?? '—'}</span><span style={{ flex: 1 }}>{c.question}</span><Badge s={c.status} />{c.origin === 'AI' && <span className="badge pur">AI</span>}</div>
            {c.answer && <div className="sub">Jawaban: {c.answer}</div>}
            {canWrite && c.status !== 'ANSWERED' && <div className="row" style={{ marginTop: 6 }}>
              {c.status === 'DRAFT' && <button className="btn sec sm" onClick={() => act.run(async () => { await api(`/api/v1/tenders/${id}/clarifications/${c.id}`, { method: 'PATCH', body: { status: 'SUBMITTED' } }); onDone(); })}>Tandai diajukan</button>}
              <button className="btn sec sm" onClick={() => { const a = window.prompt('Jawaban panitia:'); if (a) act.run(async () => { await api(`/api/v1/tenders/${id}/clarifications/${c.id}`, { method: 'PATCH', body: { status: 'ANSWERED', answer: a } }); onDone(); }); }}>Catat jawaban</button>
            </div>}
          </div>)) : <div className="empty">Belum ada pertanyaan</div>}
      </div>
      {canWrite && <div className="card">
        <Field label="Pertanyaan aanwijzing baru"><textarea value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <button className="btn sm" disabled={q.length < 10 || act.busy} onClick={() => act.run(async () => { await api(`/api/v1/tenders/${id}/clarifications`, { body: { question: q } }); setQ(''); onDone(); })}>Tambah</button>
      </div>}
    </>
  );
}
