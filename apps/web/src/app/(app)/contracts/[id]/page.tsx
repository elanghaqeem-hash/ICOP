'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, apiDownload, apiUpload, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
import SlaEditor from '@/components/SlaEditor';

const LABEL: Record<string, string> = {
  identitas_para_pihak: 'Identitas para pihak & kewenangan penandatangan', ruang_lingkup_sesuai_penawaran: 'Ruang lingkup sesuai penawaran/SOW', nilai_dan_pajak: 'Nilai & pajak (PPN)',
  termin_pembayaran: 'Termin pembayaran', sla_dan_denda: 'SLA & denda', kerahasiaan_nda: 'Kerahasiaan / NDA', pelindungan_data_pribadi: 'Pelindungan data pribadi (UU PDP)',
  hak_kekayaan_intelektual: 'Hak kekayaan intelektual', force_majeure: 'Force majeure', penyelesaian_sengketa: 'Penyelesaian sengketa',
};

export default function ContractDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const perms = me?.permissions ?? [];
  const { data, error, loading, reload } = useApi(`/api/v1/contracts/${id}`);
  const contractSla = useApi(`/api/v1/contracts/${id}/sla`);
  const act = useAction();
  const [edit, setEdit] = useState<any>(null);
  const [check, setCheck] = useState<Record<string, boolean>>({});
  const [legalNote, setLegalNote] = useState('');
  const [signerTitle, setSignerTitle] = useState('');
  const [upload, setUpload] = useState<{ file: File | null; signerName: string; signerTitle: string }>({ file: null, signerName: '', signerTitle: '' });
  const [esign, setEsign] = useState({ provider: '', signerName: '', signerEmail: '', signerTitle: '', internalName: '', internalEmail: '' });
  const [finalFile, setFinalFile] = useState<File | null>(null);
  const [verifyNote, setVerifyNote] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { if (data) setCheck(data.contract.legalChecklist ?? {}); }, [data]);
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const c = data.contract;
  const canWrite = perms.includes('contract.write');
  const isLegal = perms.includes('contract.legal');
  const sigs = data.signatures as any[];
  const internalOk = sigs.some((s) => s.party === 'INTERNAL' && s.status === 'VERIFIED');
  const customerOk = sigs.some((s) => s.party === 'CUSTOMER' && s.status === 'VERIFIED');
  const call = (path: string, body: any = {}, after?: (r: any) => void, idem = false) => act.run(async () => {
    const r = await api(`/api/v1/contracts/${id}/${path}`, { body, idempotencyKey: idem ? newKey() : undefined }); after?.(r); reload();
  });
  const saveEdit = () => act.run(async () => {
    await api(`/api/v1/contracts/${id}`, { method: 'PUT', body: { rowVersion: c.rowVersion, ...edit } }); setEdit(null); reload();
  });
  const doUpload = () => act.run(async () => {
    const f = new FormData(); f.append('signerName', upload.signerName); if (upload.signerTitle) f.append('signerTitle', upload.signerTitle); f.append('file', upload.file!);
    await apiUpload(`/api/v1/contracts/${id}/signatures/customer/upload`, f); setUpload({ file: null, signerName: '', signerTitle: '' }); setMsg('Dokumen bertanda tangan diunggah — menunggu verifikasi Legal'); reload();
  });

  return (
    <>
      <PageHead title={c.number} crumbs={<Link href="/contracts">Kontrak</Link>} sub={<>{c.title} · {c.customerName}</>} actions={<><span className="badge">{c.contractType}</span><Badge s={c.status} /></>} />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}

      <div className="card">
        <dl className="kv">
          <dt>Nilai (sebelum PPN)</dt><dd>{idr(c.value)} · PPN {Number(c.taxRate)}%</dd>
          <dt>Periode</dt><dd>{String(c.startDate).slice(0, 10)} s/d {String(c.endDate).slice(0, 10)}</dd>
          <dt>Termin</dt><dd>{c.paymentTerms}</dd>
          <dt>SLA</dt><dd>{c.slaTerms ?? '—'}</dd>
          <dt>Denda</dt><dd>{c.penaltyTerms ?? '—'}</dd>
          {c.flexguard && <><dt>FlexGuard</dt><dd>{c.flexguard.tokens} token × {idr(c.flexguard.pricePerToken)}{c.flexguard.validMonths ? ` · ${c.flexguard.validMonths} bln` : ''}</dd></>}
          <dt>Sumber</dt><dd>{c.quotationId ? <Link href={`/quotations/${c.quotationId}`}>Quotation</Link> : c.tenderId ? <Link href={`/tenders/${c.tenderId}`}>Tender</Link> : '—'}{c.opportunityId ? <> · <Link href={`/opportunities/${c.opportunityId}`}>Opportunity</Link></> : null}</dd>
          <dt>Dibuat</dt><dd>{c.createdByName} · {dt(c.createdAt)}</dd>
          {c.legalReviewedByName && <><dt>Review legal</dt><dd>{c.legalReviewedByName} · {dt(c.legalReviewedAt)}</dd></>}
          <dt>Hash isi (SHA-256)</dt><dd className="mono" style={{ fontSize: '.75rem' }}>{data.contractHash}</dd>
          {data.project && <><dt>Proyek</dt><dd><Link href={`/projects/${data.project.id}`}>{data.project.code}</Link> <Badge s={data.project.status} /></dd></>}
          {data.wallet && <><dt>Wallet FlexGuard</dt><dd><Link href={`/flexguard/${data.wallet.id}`}>{data.wallet.code}</Link> · {Number(data.wallet.availableTokens)}/{Number(data.wallet.creditedTokens)} token</dd></>}
        </dl>
        {c.status === 'DRAFT' && canWrite && !edit && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sec" onClick={() => setEdit({ startDate: String(c.startDate).slice(0, 10), endDate: String(c.endDate).slice(0, 10), paymentTerms: c.paymentTerms, slaTerms: c.slaTerms ?? '', penaltyTerms: c.penaltyTerms ?? '' })}>Ubah</button>
            <button className="btn" disabled={act.busy} onClick={() => call('submit-legal')}>Ajukan ke Legal</button>
          </div>
        )}
        {edit && (
          <div style={{ marginTop: 10 }}>
            <div className="grid g2">
              <Field label="Mulai"><input type="date" value={edit.startDate} onChange={(e) => setEdit({ ...edit, startDate: e.target.value })} /></Field>
              <Field label="Selesai"><input type="date" value={edit.endDate} onChange={(e) => setEdit({ ...edit, endDate: e.target.value })} /></Field>
            </div>
            <Field label="Termin pembayaran (mis. 30% DP, 50% progress, 20% BAST)"><input value={edit.paymentTerms} onChange={(e) => setEdit({ ...edit, paymentTerms: e.target.value })} /></Field>
            <Field label="SLA"><textarea value={edit.slaTerms} onChange={(e) => setEdit({ ...edit, slaTerms: e.target.value })} /></Field>
            <Field label="Denda"><input value={edit.penaltyTerms} onChange={(e) => setEdit({ ...edit, penaltyTerms: e.target.value })} /></Field>
            <div className="row"><button className="btn" disabled={act.busy} onClick={saveEdit}>Simpan</button><button className="btn sec" onClick={() => setEdit(null)}>Batal</button></div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Dokumen kontrak final (PDF)</h2>
        <p className="sub">Versi yang akan ditandatangani. Hash-nya ikut dikunci pada otorisasi internal; wajib untuk e-sign VIDA. Hanya dapat diganti saat DRAFT/LEGAL REVIEW.</p>
        {data.finalDocument ? (
          <div className="row"><span>{data.finalDocument.filename}</span><span className="sub">{data.finalDocument.pageCount ?? '—'} hal. · SHA-256 {String(data.finalDocument.sha256).slice(0, 12)}…</span><span className="spacer" />
            <button className="btn sec sm" onClick={() => act.run(() => apiDownload(`/api/v1/documents/${data.finalDocument.id}/file?variant=original`, data.finalDocument.filename))}>Unduh</button></div>
        ) : <div className="empty">Belum diunggah</div>}
        {canWrite && ['DRAFT', 'LEGAL_REVIEW'].includes(c.status) && (
          <div className="row" style={{ marginTop: 8 }}>
            <input type="file" accept="application/pdf" onChange={(e) => setFinalFile(e.target.files?.[0] ?? null)} aria-label="PDF kontrak final" />
            <button className="btn sec sm" disabled={act.busy || !finalFile} onClick={() => act.run(async () => {
              const f = new FormData(); f.append('file', finalFile!);
              const r = await apiUpload(`/api/v1/contracts/${id}/final-document`, f); setFinalFile(null); setMsg(`PDF final tersimpan (${r.pages} halaman)`); reload();
            })}>{data.finalDocument ? 'Ganti PDF final' : 'Unggah PDF final'}</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Checklist legal</h2>
        {data.legalChecklistKeys.map((k: string) => (
          <label key={k} className="check" style={{ padding: '3px 0' }}>
            <input type="checkbox" disabled={!(isLegal && c.status === 'LEGAL_REVIEW')} checked={!!check[k]} onChange={(e) => setCheck({ ...check, [k]: e.target.checked })} /> {LABEL[k] ?? k}
          </label>
        ))}
        {isLegal && c.status === 'LEGAL_REVIEW' && (
          <>
            {c.createdBy === me?.id && <div className="alert warn">SoD: Anda pembuat kontrak ini, tidak dapat mereview.</div>}
            <Field label="Catatan legal"><textarea value={legalNote} onChange={(e) => setLegalNote(e.target.value)} /></Field>
            <div className="row">
              <button className="btn ok" disabled={act.busy} onClick={() => call('legal-review', { checklist: check, note: legalNote || undefined, decision: 'APPROVE' }, (r) => setMsg(`Disetujui Legal — diajukan ke approval level ${r.requiredLevel}`))}>Setujui & ajukan approval</button>
              <button className="btn bad" disabled={act.busy || !legalNote} onClick={() => call('legal-review', { checklist: check, note: legalNote, decision: 'RETURN' })}>Kembalikan</button>
            </div>
          </>
        )}
      </div>

      {data.approvals.length > 0 && (
        <div className="card"><h2>Approval</h2>
          {data.approvals.map((a: any) => <Link key={a.id} href={`/approvals/${a.id}`} className="list-item"><div className="row"><span>Level {a.requiredLevel}</span><span className="spacer" /><Badge s={a.status} /></div><div className="sub">{dt(a.createdAt)}{a.decidedAt ? ` → ${dt(a.decidedAt)}` : ''}</div></Link>)}
        </div>
      )}

      <div className="card">
        <h2>Tanda tangan</h2>
        <p className="sub">Otorisasi internal ICOP bukan tanda tangan elektronik tersertifikasi. Tanda tangan customer: unggah dokumen bertanda tangan (diverifikasi Legal) atau penyedia e-sign terkonfigurasi.</p>
        {sigs.length ? sigs.map((s) => (
          <div key={s.id} className="list-item">
            <div className="row"><b>{s.party}</b><span className="sub">{s.method}{s.provider ? ` · ${s.provider}` : ''}</span><span className="spacer" /><Badge s={s.status} /></div>
            <div className="sub">{s.signerName}{s.signerTitle ? `, ${s.signerTitle}` : ''} · {dt(s.signedAt)}{s.verifiedByName ? ` · diverifikasi ${s.verifiedByName}` : ''}{s.evidence?.legallyBinding === false ? ' · SANDBOX (tidak mengikat hukum)' : ''}</div>
            {s.status === 'PENDING' && Array.isArray(s.evidence?.signingLinks) && s.evidence.signingLinks.length > 0 && (
              <div className="sub" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>Tautan tanda tangan: {s.evidence.signingLinks.map((l: any) => <div key={l.email}>{l.email}: <a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></div>)}
                {s.evidence.providerStatus && <div>Status penyedia: {s.evidence.providerStatus}{s.evidence.lastPolledAt ? ` · dicek ${dt(s.evidence.lastPolledAt)}` : ''}</div>}</div>
            )}
            {s.status === 'PENDING' && s.provider && s.provider !== 'sandbox' && <button className="btn sec sm" style={{ marginTop: 4 }} disabled={act.busy} onClick={() => call(`signatures/${s.id}/refresh`, {}, (r) => setMsg(r.changed ? `Status diperbarui: ${r.status}` : `Masih menunggu tanda tangan (${r.providerStatus ?? r.status})`))}>Cek status</button>}
            {s.documentId && <button className="btn sec sm" style={{ marginTop: 4 }} onClick={() => act.run(() => apiDownload(`/api/v1/documents/${s.documentId}/file?variant=original`, 'kontrak-ttd.pdf'))}>Unduh dokumen</button>}
            {s.status === 'SIGNED' && isLegal && s.evidence?.uploadedBy !== me?.id && (
              <div style={{ marginTop: 6 }}>
                <Field label="Catatan verifikasi"><input value={verifyNote} onChange={(e) => setVerifyNote(e.target.value)} placeholder="Cocok dengan versi final, penandatangan berwenang" /></Field>
                <div className="row">
                  <button className="btn ok sm" disabled={act.busy || verifyNote.length < 5} onClick={() => call(`signatures/${s.id}/verify`, { decision: 'VERIFY', note: verifyNote })}>Verifikasi</button>
                  <button className="btn bad sm" disabled={act.busy || verifyNote.length < 5} onClick={() => call(`signatures/${s.id}/verify`, { decision: 'REJECT', note: verifyNote })}>Tolak</button>
                </div>
              </div>
            )}
          </div>
        )) : <div className="empty">Belum ada</div>}

        {c.status === 'PENDING_SIGNATURE' && (
          <>
            {!internalOk && (
              <div style={{ marginTop: 10 }}>
                <h3>Otorisasi internal</h3>
                <p className="sub">Pejabat dengan level ≥ level approval kontrak, bukan pembuat kontrak.</p>
                <Field label="Jabatan penandatangan"><input value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} placeholder="Direktur Utama" /></Field>
                <button className="btn" disabled={act.busy || signerTitle.length < 2} onClick={() => { if (window.confirm(`Saya, ${me?.fullName}, mengotorisasi kontrak ${c.number} atas nama perusahaan.`)) call('signatures/internal', { signerTitle, confirm: true }); }}>Otorisasi</button>
              </div>
            )}
            {!customerOk && canWrite && (
              <div style={{ marginTop: 10 }}>
                <h3>Tanda tangan customer — unggah dokumen</h3>
                <div className="grid g2">
                  <Field label="Nama penandatangan"><input value={upload.signerName} onChange={(e) => setUpload({ ...upload, signerName: e.target.value })} /></Field>
                  <Field label="Jabatan"><input value={upload.signerTitle} onChange={(e) => setUpload({ ...upload, signerTitle: e.target.value })} /></Field>
                </div>
                <Field label="File PDF/scan (maks 50 MB)"><input type="file" accept="application/pdf,image/*" onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })} /></Field>
                <button className="btn sec" disabled={act.busy || !upload.file || upload.signerName.length < 2} onClick={doUpload}>Unggah</button>
                <div style={{ marginTop: 10 }}>
                  <h3>Atau kirim via e-sign</h3>
                  <p className="sub">VIDA: tanda tangan digital tersertifikasi (PSrE) memakai PDF kontrak final; status ditarik otomatis tiap 15 menit. Penyedia diatur admin di Pengaturan → Integrasi.</p>
                  <div className="grid g2">
                    <Field label="Penyedia"><select value={esign.provider} onChange={(e) => setEsign({ ...esign, provider: e.target.value })}><option value="">Pilih…</option>
                      {data.esignProviders.map((p: any) => <option key={p.name} value={p.name} disabled={!p.enabled}>{p.name.toUpperCase()} — {p.note}</option>)}</select></Field>
                    <Field label="Nama penanda tangan customer"><input value={esign.signerName} onChange={(e) => setEsign({ ...esign, signerName: e.target.value })} /></Field>
                    <Field label="Email penanda tangan customer"><input type="email" value={esign.signerEmail} onChange={(e) => setEsign({ ...esign, signerEmail: e.target.value })} /></Field>
                    <Field label="Jabatan"><input value={esign.signerTitle} onChange={(e) => setEsign({ ...esign, signerTitle: e.target.value })} /></Field>
                    <Field label="Penanda tangan DefendIT360 (opsional, urutan ke-2)"><input value={esign.internalName} onChange={(e) => setEsign({ ...esign, internalName: e.target.value })} placeholder="Nama Direktur" /></Field>
                    <Field label="Email penanda tangan DefendIT360"><input type="email" value={esign.internalEmail} onChange={(e) => setEsign({ ...esign, internalEmail: e.target.value })} /></Field>
                  </div>
                  {data.esignProviders.find((p: any) => p.name === esign.provider)?.needsDocument && !data.finalDocument && <div className="alert warn">Unggah PDF kontrak final terlebih dahulu (saat DRAFT/LEGAL REVIEW).</div>}
                  <button className="btn sec" disabled={act.busy || !esign.provider || !esign.signerEmail || esign.signerName.length < 2} onClick={() => call('signatures/customer/esign', {
                    provider: esign.provider, signerName: esign.signerName, signerEmail: esign.signerEmail, signerTitle: esign.signerTitle || undefined,
                    internalSigner: esign.internalName && esign.internalEmail ? { name: esign.internalName, email: esign.internalEmail } : undefined,
                  }, (r) => setMsg(`Permintaan tanda tangan dikirim${r.legallyBinding ? '' : ' (SANDBOX — tidak mengikat hukum)'}. ${r.signingLinks?.length ? 'Tautan tanda tangan dikirim penyedia ke email penanda tangan.' : ''}`))}>Kirim permintaan tanda tangan</button>
                </div>
              </div>
            )}
            {canWrite && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn ok" disabled={act.busy || !internalOk || !customerOk} onClick={() => call('activate', {}, (r) => setMsg(`Kontrak aktif. Proyek ${r.projectCode} dibuat${r.walletId ? ' + wallet FlexGuard' : ''}.`), true)}>Aktifkan kontrak</button>
                {(!internalOk || !customerOk) && <span className="sub">Butuh tanda tangan internal & customer terverifikasi.</span>}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>SLA layanan berdasarkan kontrak</h2>
        <p className="sub">Klausul SLA yang disahkan di kontrak berlaku lebih dahulu daripada kebijakan tenant. Prioritas tanpa klausul menggunakan standar tenant/default. Pastikan target sesuai PKS yang ditandatangani.</p>
        <ErrorBox error={contractSla.error}/>
        {contractSla.loading ? <Loading/> :
          <SlaEditor initial={contractSla.data?.items ?? []}
            endpoint={`/api/v1/contracts/${id}/sla`} mode="contract"
            canEdit={canWrite} onSaved={contractSla.reload}/>}
      </div>

      <div className="card">
        <h2>Kewajiban</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>Jenis</th><th>Deskripsi</th><th>Jatuh tempo</th><th className="r">Nilai</th><th>Status</th></tr></thead>
          <tbody>{data.obligations.map((o: any) => <tr key={o.id}><td>{o.kind}</td><td>{o.description}</td><td>{o.dueDate ? String(o.dueDate).slice(0, 10) : '—'}</td><td className="r">{o.amount ? idr(o.amount) : ''}</td><td><Badge s={o.status} /></td></tr>)}</tbody></table></div>
      </div>
    </>
  );
}
