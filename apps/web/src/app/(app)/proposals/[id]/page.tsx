'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, apiDownload, dt } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function ProposalEditor() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data: p, error, loading, reload } = useApi(`/api/v1/proposals/${id}`);
  const versions = useApi(`/api/v1/proposals/${id}/versions`);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [instr, setInstr] = useState('');
  const [blockers, setBlockers] = useState<string[]>([]);
  const [diff, setDiff] = useState<any>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const act = useAction();
  if (loading && !p) return <Loading />;
  if (!p) return <ErrorBox error={error} />;
  const perms = me?.permissions ?? [];
  const w = perms.includes('proposal.write');
  const isReviewer = perms.includes('proposal.review') && p.createdBy !== me?.id;
  const open = p.sections.filter((s: any) => s.status === 'FLAGGED' || s.content.includes('[PERLU DILENGKAPI]'));
  const run = (fn: () => Promise<unknown>) => act.run(async () => {
    setBlockers([]);
    try { await fn(); } catch (e) { if (e instanceof ApiError && (e.details as any)?.blockers) setBlockers((e.details as any).blockers); if (e instanceof ApiError && (e.details as any)?.sections) setBlockers((e.details as any).sections); throw e; }
    reload(); versions.reload();
  });

  return (
    <>
      <PageHead crumbs={<>{p.tenderId ? <Link href={`/tenders/${p.tenderId}`}>{p.tenderCode}</Link> : null} {p.tenderId ? '/' : ''} <Link href={`/opportunities/${p.opportunityId}`}>{p.opportunityCode}</Link></>}
        title={p.title} sub={`${p.number} · v${p.version} · ${p.customerName} · ${p.language === 'en' ? 'English' : 'Bahasa Indonesia'}${p.reviewerName ? ` · direview ${p.reviewerName} ${dt(p.reviewedAt)}` : ''}`}
        actions={<Badge s={p.status} />} />
      <ErrorBox error={act.error} />
      {blockers.length > 0 && <div className="alert bad"><b>Belum dapat diproses:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
      {open.length > 0 && <div className="alert warn">{open.length} bagian masih memuat klaim tidak terverifikasi atau [PERLU DILENGKAPI]. Proposal tidak dapat disetujui sampai seluruhnya diselesaikan.</div>}
      {p.reviewNote && p.status === 'DRAFT' && <div className="alert info">Catatan reviewer: {p.reviewNote}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {w && p.status === 'DRAFT' && <button className="btn pur sm" disabled={act.busy} onClick={() => run(() => api(`/api/v1/proposals/${id}/submit-review`, { body: {} }))}>Ajukan review teknis</button>}
        {isReviewer && p.status === 'IN_REVIEW' && <>
          <button className="btn ok sm" disabled={act.busy} onClick={() => run(() => api(`/api/v1/proposals/${id}/review`, { body: { decision: 'APPROVE' } }))}>Setujui (sign-off)</button>
          <button className="btn bad sm" disabled={act.busy} onClick={() => { const note = window.prompt('Catatan pengembalian:'); if (note) run(() => api(`/api/v1/proposals/${id}/review`, { body: { decision: 'RETURN', note } })); }}>Kembalikan</button></>}
        {w && <button className="btn sec sm" disabled={act.busy} onClick={() => run(() => api(`/api/v1/proposals/${id}/regenerate`, { body: {} }))}>Perbarui dari data</button>}
        <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/proposals/${id}/export.docx`, `${p.number}.docx`))}>Word (.docx)</button>
        <button className="btn sec sm" onClick={() => act.run(async () => setPreview(await api(`/api/v1/proposals/${id}/document`)))}>Pratinjau / PDF</button>
      </div>
      {preview && (
        <div className="card">
          <div className="row"><h3 style={{ margin: 0 }}>Pratinjau</h3><span className="spacer" />
            <button className="btn sec sm" onClick={() => { const wdw = window.open('', '_blank'); if (wdw) { wdw.document.write(preview); wdw.document.close(); wdw.focus(); wdw.print(); } }}>Cetak / simpan PDF</button>
            <button className="btn sec sm" onClick={() => setPreview(null)}>Tutup</button></div>
          <iframe title="Pratinjau proposal" sandbox="allow-same-origin allow-modals" srcDoc={preview} style={{ width: '100%', height: 640, border: '1px solid var(--line)', borderRadius: 8, marginTop: 8, background: '#fff' }} />
        </div>
      )}

      {p.sections.map((s: any, i: number) => (
        <div key={s.id} className="card" id={s.key}>
          <div className="row"><b>{i}. {s.title}</b>{s.required && <span className="badge">wajib</span>}<span className="spacer" /><Badge s={s.status} />{s.generatedBy && <span className="sub">{s.generatedBy}</span>}</div>
          {s.flags?.map((f: string) => <div key={f} className="alert bad" style={{ margin: '6px 0' }}>{f}</div>)}
          {s.missingInfo?.length > 0 && <div className="alert warn" style={{ margin: '6px 0' }}>Info belum tersedia: {s.missingInfo.join('; ')}</div>}
          {editing === s.key ? (
            <>
              <textarea style={{ minHeight: 220, marginTop: 6 }} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`Isi ${s.title}`} />
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm" disabled={act.busy} onClick={() => run(async () => { await api(`/api/v1/proposals/${id}/sections/${s.key}`, { method: 'PUT', body: { content: draft } }); setEditing(null); })}>Simpan</button>
                <button className="btn sec sm" onClick={() => setEditing(null)}>Batal</button>
              </div>
            </>
          ) : (
            <div className="ai-out" style={{ marginTop: 6, background: s.content.trim() ? '#fff' : '#fafbfd' }}>{s.content || '(kosong — bagian opsional tidak dicetak)'}</div>
          )}
          {s.sources?.length > 0 && <div className="sub" style={{ marginTop: 6 }}>Sumber: {s.sources.map((x: any) => x.label).join('; ')}</div>}
          {w && editing !== s.key && (
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sec sm" onClick={() => { setEditing(s.key); setDraft(s.content); }}>Edit</button>
              {s.content.trim() && <>
                <input style={{ flex: 1, minWidth: 160 }} placeholder="Instruksi AI (opsional)" value={instr} onChange={(e) => setInstr(e.target.value)} aria-label="Instruksi AI" />
                <button className="btn pur sm" disabled={act.busy} onClick={() => run(() => api(`/api/v1/proposals/${id}/sections/${s.key}/ai`, { body: { instruction: instr || undefined } }))}>Tulis ulang AI</button></>}
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <h3>Versi & perbandingan</h3>
        {versions.data?.items.map((v: any) => (
          <div key={v.id} className="step"><span className="badge">v{v.version}</span> {v.reason}<span className="sub">{dt(v.createdAt)} · {v.byName ?? ''}</span>
            <button className="btn sec sm" onClick={() => act.run(async () => setDiff(await api(`/api/v1/proposals/${id}/diff?from=${v.id}&to=current`)))}>Bandingkan dgn saat ini</button></div>
        ))}
        {diff && (diff.sections.length ? diff.sections.map((s: any) => (
          <details key={s.key} open><summary>{s.title}</summary>
            {s.changes.map((c: any, i: number) => <div key={i} className="mono" style={{ background: c.op === 'add' ? 'var(--ok-soft)' : 'var(--bad-soft)', padding: '2px 6px', whiteSpace: 'pre-wrap' }}>{c.op === 'add' ? '+ ' : '− '}{c.line ?? c.to}</div>)}
          </details>)) : <div className="empty">Tidak ada perubahan</div>)}
      </div>
    </>
  );
}
