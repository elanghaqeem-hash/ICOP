'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const today = () => new Date().toISOString().slice(0, 10);

export default function ServiceRequest() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const perms = me?.permissions ?? [];
  const { data, error, loading, reload } = useApi(`/api/v1/flexguard/requests/${id}`);
  const pol = useApi('/api/v1/flexguard/policy');
  const users = useApi(perms.includes('flexguard.deliver') ? '/api/v1/users' : null);
  const act = useAction();
  const [lines, setLines] = useState<{ role: string; md: number }[]>([{ role: 'senior', md: 1 }]);
  const [opt, setOpt] = useState({ overseas: false, rush: false, note: '' });
  const [est, setEst] = useState<any>(null);
  const [ts, setTs] = useState({ workDate: today(), role: 'senior', md: 1, note: '', evidence: '' });
  const [pmId, setPmId] = useState('');
  const [deliverable, setDeliverable] = useState('');
  const [evidence, setEvidence] = useState('');
  const [cancel, setCancel] = useState({ reason: '', fee: 0 });
  const [dispute, setDispute] = useState({ actualTokens: '', resolution: '' });
  const [msg, setMsg] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const s = data.request;
  const roles = pol.data ? Object.keys(pol.data.tdc) : [];
  const call = (path: string, body: any = {}, after?: (r: any) => void) => act.run(async () => { const r = await api(`/api/v1/flexguard/requests/${id}/${path}`, { body }); after?.(r); reload(); });
  const pms = (users.data?.items ?? []).filter((u: any) => u.role === 'project_manager');

  return (
    <>
      <PageHead title={s.code} crumbs={<><Link href="/flexguard">FlexGuard</Link> / <Link href={`/flexguard/${s.walletId}`}>{s.walletCode}</Link></>}
        sub={<>{s.title} · {s.serviceLine} · {s.customerName}</>} actions={<Badge s={s.status} />} />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card">
        <dl className="kv">
          <dt>Deskripsi</dt><dd>{s.description ?? '—'}</dd>
          <dt>Estimasi / reserved / aktual</dt><dd>{s.estimatedTokens ?? '—'} / {Number(s.reservedTokens)} / {s.actualTokens ?? '—'} token</dd>
          <dt>Harga/token wallet</dt><dd>{idr(s.pricePerToken)}</dd>
          <dt>PM</dt><dd>{s.pmName ?? '—'}</dd>
          {s.floorCheck && <><dt>Floor check</dt><dd>{s.floorCheck.belowFloor ? <span className="badge bad">di bawah floor</span> : <span className="badge ok">OK</span>} debit {idr(s.floorCheck.debitValue)} vs floor {idr(s.floorCheck.floorValue)}</dd></>}
          {s.approvalRequestId && <><dt>Approval</dt><dd><Link href={`/approvals/${s.approvalRequestId}`}>Lihat approval Direktur</Link></dd></>}
          {s.disputeNote && <><dt>Catatan sengketa</dt><dd>{s.disputeNote}</dd></>}
          {s.estimate?.actual && <><dt>Deliverable</dt><dd>{s.estimate.actual.deliverableRef} · varians {s.estimate.actual.variancePct}%</dd></>}
        </dl>
      </div>

      {['SUBMITTED', 'SCOPED'].includes(s.status) && perms.includes('flexguard.estimate') && pol.data && (
        <div className="card">
          <h2>Estimasi MD → token</h2>
          <p className="sub">Token = Σ(MD × TDC) × pengali lokasi × urgensi, dibulatkan ke atas 0,5. Floor guard otomatis.</p>
          {lines.map((l, i) => (
            <div key={i} className="grid g3">
              <Field label="Peran"><select value={l.role} onChange={(e) => { const x = [...lines]; x[i] = { ...l, role: e.target.value }; setLines(x); }}>{roles.map((r) => <option key={r} value={r}>{r} (TDC {pol.data.tdc[r]})</option>)}</select></Field>
              <Field label="MD"><input type="number" min={0} step={0.5} value={l.md} onChange={(e) => { const x = [...lines]; x[i] = { ...l, md: Number(e.target.value) }; setLines(x); }} /></Field>
              <div className="row" style={{ alignItems: 'end' }}><button className="btn sec sm" onClick={() => setLines(lines.filter((_, j) => j !== i))} disabled={lines.length === 1}>Hapus</button></div>
            </div>
          ))}
          <div className="row">
            <button className="btn sec sm" onClick={() => setLines([...lines, { role: 'junior', md: 1 }])}>+ Peran</button>
            <label className="check"><input type="checkbox" checked={opt.overseas} onChange={(e) => setOpt({ ...opt, overseas: e.target.checked })} /> Overseas ×2</label>
            <label className="check"><input type="checkbox" checked={opt.rush} onChange={(e) => setOpt({ ...opt, rush: e.target.checked })} /> Rush ×1,25</label>
          </div>
          <Field label="Catatan"><textarea value={opt.note} onChange={(e) => setOpt({ ...opt, note: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy} onClick={() => call('estimate', { lines, overseas: opt.overseas, rush: opt.rush, note: opt.note || undefined }, setEst)}>Simpan estimasi</button>
          {est && <div className="alert info" style={{ marginTop: 8 }}>Estimasi {est.tokens} token (raw {est.rawTokens}){est.floor.belowFloor ? ' — di bawah floor, perlu approval Direktur sebelum dikirim' : ''}{est.warnings.map((w: string) => ` · ${w}`)}</div>}
        </div>
      )}

      {s.status === 'SCOPED' && perms.includes('flexguard.write') && (
        <div className="card"><h2>Kirim estimasi ke customer</h2>
          <button className="btn pur" disabled={act.busy || !!s.approvalRequestId} onClick={() => call('send-to-customer', {}, (r) => setMsg(r.approvalRequired ? 'Di bawah floor — diajukan ke approval Direktur' : 'Terkirim ke portal customer'))}>Kirim ke customer</button>
          {s.approvalRequestId && <span className="sub"> Menunggu approval.</span>}
        </div>
      )}

      {s.status === 'PENDING_CUSTOMER_APPROVAL' && perms.includes('flexguard.write') && (
        <div className="card"><h2>Persetujuan atas nama customer</h2>
          <p className="sub">Hanya bila customer menyetujui di luar portal (email/PO). Bukti wajib dicatat; token akan di-reserve.</p>
          <Field label="Referensi bukti"><input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="mis. Email 12/10 dari PIC, PO-123" /></Field>
          <button className="btn" disabled={act.busy || evidence.length < 5} onClick={() => call('customer-approve', { evidenceRef: evidence })}>Catat persetujuan & reserve</button>
        </div>
      )}

      {s.status === 'APPROVED' && perms.includes('flexguard.deliver') && (
        <div className="card"><h2>Mulai pekerjaan</h2>
          <Field label="Project Manager"><select value={pmId} onChange={(e) => setPmId(e.target.value)}><option value="">Pilih PM…</option>{pms.map((u: any) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></Field>
          <button className="btn" disabled={act.busy || !pmId} onClick={() => call('start', { pmId })}>Mulai (IN PROGRESS)</button>
        </div>
      )}

      {(s.status === 'IN_PROGRESS' || data.timesheets.length > 0) && (
        <div className="card">
          <h2>Timesheet</h2>
          <div className="table-wrap"><table className="t"><thead><tr><th>Tanggal</th><th>Personel</th><th>Peran</th><th className="r">MD</th><th>Status</th><th /></tr></thead>
            <tbody>{data.timesheets.map((t: any) => (
              <tr key={t.id}><td>{String(t.workDate).slice(0, 10)}</td><td>{t.userName}<div className="sub">{t.note}</div></td><td>{t.role}</td><td className="r">{Number(t.md)}</td><td><Badge s={t.status} /></td>
                <td>{t.status === 'SUBMITTED' && perms.includes('flexguard.deliver') && t.userId !== me?.id && <div className="row">
                  <button className="btn ok sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/api/v1/flexguard/requests/${id}/timesheets/${t.id}/decide`, { body: { decision: 'APPROVE' } }); reload(); })}>Setujui</button>
                  <button className="btn bad sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/api/v1/flexguard/requests/${id}/timesheets/${t.id}/decide`, { body: { decision: 'REJECT' } }); reload(); })}>Tolak</button></div>}</td></tr>))}
              {!data.timesheets.length && <tr><td colSpan={6} className="empty">Belum ada</td></tr>}</tbody></table></div>
          {s.status === 'IN_PROGRESS' && perms.includes('flexguard.timesheet') && (
            <div style={{ marginTop: 8 }}>
              <div className="grid g3">
                <Field label="Tanggal"><input type="date" max={today()} value={ts.workDate} onChange={(e) => setTs({ ...ts, workDate: e.target.value })} /></Field>
                <Field label="Peran"><select value={ts.role} onChange={(e) => setTs({ ...ts, role: e.target.value })}>{roles.map((r) => <option key={r}>{r}</option>)}</select></Field>
                <Field label="MD (maks 1,5)"><input type="number" min={0.5} max={1.5} step={0.25} value={ts.md} onChange={(e) => setTs({ ...ts, md: Number(e.target.value) })} /></Field>
              </div>
              <Field label="Catatan / bukti"><input value={ts.note} onChange={(e) => setTs({ ...ts, note: e.target.value })} /></Field>
              <button className="btn sec" disabled={act.busy} onClick={() => call('timesheets', { workDate: ts.workDate, role: ts.role, md: ts.md, note: ts.note || undefined })}>Tambah timesheet</button>
            </div>
          )}
          {s.status === 'IN_PROGRESS' && perms.includes('flexguard.deliver') && (
            <div style={{ marginTop: 10 }}>
              <Field label="Referensi deliverable (laporan/BAST draft)"><input value={deliverable} onChange={(e) => setDeliverable(e.target.value)} /></Field>
              <button className="btn pur" disabled={act.busy || deliverable.length < 3} onClick={() => call('deliver', { deliverableRef: deliverable }, (r) => setMsg(`Diserahkan: aktual ${r.actualTokens} token (varians ${r.variancePct}%) — menunggu konfirmasi customer`))}>Serahkan hasil</button>
            </div>
          )}
        </div>
      )}

      {s.status === 'DISPUTED' && perms.includes('approval.decide') && (
        <div className="card"><h2>Penyelesaian sengketa</h2>
          <div className="grid g2">
            <Field label={`Token aktual terkoreksi (≤ ${s.actualTokens})`}><input type="number" min={0} value={dispute.actualTokens} onChange={(e) => setDispute({ ...dispute, actualTokens: e.target.value })} /></Field>
          </div>
          <Field label="Resolusi"><textarea value={dispute.resolution} onChange={(e) => setDispute({ ...dispute, resolution: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy || !dispute.actualTokens || dispute.resolution.length < 10} onClick={() => call('resolve-dispute', { actualTokens: Number(dispute.actualTokens), resolution: dispute.resolution })}>Selesaikan</button>
        </div>
      )}

      {['SUBMITTED', 'SCOPED', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED'].includes(s.status) && perms.includes('flexguard.write') && (
        <div className="card"><h2>Batalkan</h2>
          <div className="grid g2">
            <Field label="Alasan"><input value={cancel.reason} onChange={(e) => setCancel({ ...cancel, reason: e.target.value })} /></Field>
            {Number(s.reservedTokens) > 0 && <Field label="Biaya scoping (0–1 token)"><input type="number" min={0} max={1} step={0.5} value={cancel.fee} onChange={(e) => setCancel({ ...cancel, fee: Number(e.target.value) })} /></Field>}
          </div>
          <button className="btn bad" disabled={act.busy || cancel.reason.length < 5} onClick={() => { if (window.confirm('Batalkan service request?')) call('cancel', { reason: cancel.reason, scopingFeeTokens: cancel.fee }); }}>Batalkan SR</button>
        </div>
      )}

      <div className="card"><h2>Mutasi token</h2>
        {data.ledger.length ? data.ledger.map((t: any) => <div key={t.id} className="row sub" style={{ padding: '3px 0' }}><Badge s={t.type} /><span>avail {Number(t.dAvailable)} · rsv {Number(t.dReserved)} · used {Number(t.dConsumed)}</span><span className="spacer" />{dt(t.createdAt)}</div>) : <div className="empty">Belum ada</div>}
      </div>
    </>
  );
}
