'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const n = (x: unknown) => Number(x ?? 0);
const d = (x: unknown) => { const v = n(x); return v === 0 ? '' : (v > 0 ? '+' : '') + v; };

export default function WalletDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const perms = me?.permissions ?? [];
  const { data, error, loading, reload } = useApi(`/api/v1/flexguard/wallets/${id}`);
  const act = useAction();
  const [req, setReq] = useState<{ type: string; tokens: string; months: string; txId: string; pricePerToken: string; reason: string }>({ type: 'TOPUP', tokens: '', months: '3', txId: '', pricePerToken: '', reason: '' });
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [stmt, setStmt] = useState<any>(null);
  const [sr, setSr] = useState({ serviceLine: '', title: '', description: '' });
  const [msg, setMsg] = useState('');
  const pol = useApi('/api/v1/flexguard/policy');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const w = data.wallet; const m = data.metrics;
  const canWrite = perms.includes('flexguard.write');

  const submitReq = () => act.run(async () => {
    const body: any = { type: req.type, reason: req.reason };
    if (req.type === 'TOPUP') { body.tokens = Number(req.tokens); if (req.pricePerToken) body.pricePerToken = Number(req.pricePerToken); }
    if (req.type === 'ADJUSTMENT') body.tokens = Number(req.tokens);
    if (req.type === 'ROLLOVER') body.months = Number(req.months);
    if (req.type === 'REVERSAL') body.txId = Number(req.txId);
    const r = await api(`/api/v1/flexguard/wallets/${id}/requests`, { body, idempotencyKey: newKey() });
    setMsg(`Diajukan ke approval (level ${r.requiredLevel}). Saldo berubah setelah disetujui.`);
    setReq({ ...req, tokens: '', txId: '', reason: '' });
    reload();
  });
  const loadStmt = () => act.run(async () => setStmt(await api(`/api/v1/flexguard/wallets/${id}/statement?month=${month}`)));
  const redeem = (i: number) => act.run(async () => { await api(`/api/v1/flexguard/wallets/${id}/complimentary/${i}/redeem`, { body: {} }); reload(); });
  const createSr = () => act.run(async () => {
    const s = await api('/api/v1/flexguard/requests', { body: { walletId: id, serviceLine: sr.serviceLine || pol.data?.serviceLines[0], title: sr.title, description: sr.description || undefined } });
    window.location.href = `/flexguard/requests/${s.id}`;
  });

  return (
    <>
      <PageHead title={w.code} crumbs={<Link href="/flexguard">FlexGuard</Link>} sub={<>{w.customerName} · paket {w.package} · kontrak {w.contractNumber ?? '—'}</>} actions={<Badge s={w.status} />} />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      {!data.reconciliation.ok && <div className="alert bad">Rekonsiliasi ledger tidak seimbang — hubungi Finance. Ledger {JSON.stringify(data.reconciliation.ledger)} vs cache {JSON.stringify(data.reconciliation.cache)}</div>}
      <div className="grid g4">
        <div className="card kpi"><div className="l">Tersedia</div><div className="v">{n(w.availableTokens)}</div><div className="l">{m.availablePct}% · {idr(m.valueAvailable)}</div></div>
        <div className="card kpi"><div className="l">Reserved</div><div className="v">{n(w.reservedTokens)}</div><div className="l">terpakai {n(w.consumedTokens)} · hangus {n(w.expiredTokens)}</div></div>
        <div className="card kpi"><div className="l">Utilisasi</div><div className="v">{m.utilizationPct}%</div><div className="l">burn {m.monthlyBurn}/bln{m.daysUntilDepletion !== null ? ` · habis ±${m.daysUntilDepletion} hr` : ''}</div></div>
        <div className="card kpi"><div className="l">Berlaku s/d</div><div className="v">{String(w.validUntil).slice(0, 10)}</div><div className="l">{m.daysUntilExpiry} hari · berisiko hangus {m.atRiskOfExpiry}</div></div>
      </div>
      <div className="sub" style={{ margin: '4px 0 10px' }}>Harga {idr(w.pricePerToken)}/token · total dikreditkan {n(w.creditedTokens)} · rollover {w.rolloverAllowed ? 'ya' : 'tidak'} · rekonsiliasi {data.reconciliation.ok ? 'OK' : 'SELISIH'}</div>

      {Array.isArray(w.complimentary) && w.complimentary.length > 0 && (
        <div className="card"><h2>Complimentary</h2>
          {w.complimentary.map((c: any, i: number) => (
            <div key={i} className="row" style={{ padding: '4px 0' }}><span>{c.item}</span><Badge s={c.status} /><span className="sub">tukar sebelum {c.redeemBy}</span><span className="spacer" />
              {canWrite && c.status === 'AVAILABLE' && <button className="btn sec sm" disabled={act.busy} onClick={() => redeem(i)}>Tandai ditukar</button>}</div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row"><h2 style={{ margin: 0 }}>Service request</h2><span className="spacer" /></div>
        {data.requests.length ? data.requests.map((s: any) => (
          <Link key={s.id} href={`/flexguard/requests/${s.id}`} className="list-item"><div className="row"><b className="mono">{s.code}</b><span className="sub">{s.serviceLine}</span><span className="spacer" /><Badge s={s.status} /></div>
            <div className="sub">{s.title} · estimasi {s.estimatedTokens ?? '—'} · reserved {n(s.reservedTokens)} · aktual {s.actualTokens ?? '—'}</div></Link>
        )) : <div className="empty">Belum ada</div>}
        {canWrite && w.status === 'ACTIVE' && pol.data && (
          <div style={{ marginTop: 10 }}>
            <h3>Buat service request</h3>
            <div className="grid g2">
              <Field label="Layanan"><select value={sr.serviceLine || pol.data.serviceLines[0]} onChange={(e) => setSr({ ...sr, serviceLine: e.target.value })}>{pol.data.serviceLines.map((s: string) => <option key={s}>{s}</option>)}</select></Field>
              <Field label="Judul"><input value={sr.title} onChange={(e) => setSr({ ...sr, title: e.target.value })} /></Field>
            </div>
            <Field label="Deskripsi"><textarea value={sr.description} onChange={(e) => setSr({ ...sr, description: e.target.value })} /></Field>
            <button className="btn" disabled={act.busy || sr.title.length < 3} onClick={createSr}>Buat SR</button>
          </div>
        )}
      </div>

      {canWrite && (
        <div className="card">
          <h2>Pengajuan perubahan saldo</h2>
          <p className="sub">Semua perubahan saldo melalui approval DoA (FLEXGUARD_VALUE / BELOW_FLOOR). Ledger append-only; koreksi = reversal.</p>
          <div className="grid g2">
            <Field label="Jenis"><select value={req.type} onChange={(e) => setReq({ ...req, type: e.target.value })}>
              <option value="TOPUP">Top-up</option>{w.rolloverAllowed && <option value="ROLLOVER">Rollover masa berlaku</option>}<option value="ADJUSTMENT">Adjustment (±, maks 1000)</option><option value="REVERSAL">Reversal transaksi</option></select></Field>
            {(req.type === 'TOPUP' || req.type === 'ADJUSTMENT') && <Field label="Token"><input type="number" value={req.tokens} onChange={(e) => setReq({ ...req, tokens: e.target.value })} /></Field>}
            {req.type === 'TOPUP' && <Field label={`Harga/token (default ${idr(w.pricePerToken)})`}><input type="number" value={req.pricePerToken} onChange={(e) => setReq({ ...req, pricePerToken: e.target.value })} /></Field>}
            {req.type === 'ROLLOVER' && <Field label="Perpanjangan (bulan)"><input type="number" min={1} max={12} value={req.months} onChange={(e) => setReq({ ...req, months: e.target.value })} /></Field>}
            {req.type === 'REVERSAL' && <Field label="ID transaksi"><select value={req.txId} onChange={(e) => setReq({ ...req, txId: e.target.value })}><option value="">Pilih…</option>
              {data.ledger.filter((t: any) => t.type !== 'REVERSAL' && !data.ledger.some((x: any) => String(x.reversesTxId) === String(t.id))).map((t: any) => <option key={t.id} value={t.id}>#{t.id} {t.type} {t.reason?.slice(0, 40)}</option>)}</select></Field>}
          </div>
          <Field label="Alasan"><textarea value={req.reason} onChange={(e) => setReq({ ...req, reason: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy || req.reason.length < 5} onClick={submitReq}>Ajukan</button>
          {data.approvals.length > 0 && <div style={{ marginTop: 10 }}>{data.approvals.map((a: any) => (
            <Link key={a.id} href={`/approvals/${a.id}`} className="list-item"><div className="row"><span>{a.summary?.title}</span><span className="spacer" /><Badge s={a.status} /></div><div className="sub">{dt(a.createdAt)}</div></Link>))}</div>}
        </div>
      )}

      <div className="card">
        <h2>Statement bulanan</h2>
        <div className="row"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ maxWidth: 180 }} aria-label="Bulan" /><button className="btn sec sm" disabled={act.busy} onClick={loadStmt}>Tampilkan</button></div>
        {stmt && (
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Saldo awal tersedia</dt><dd>{stmt.opening.available}</dd>
            <dt>Dikreditkan</dt><dd>{stmt.movements.credited}</dd>
            <dt>Terpakai</dt><dd>{stmt.movements.consumed}</dd>
            <dt>Hangus</dt><dd>{stmt.movements.expired}</dd>
            <dt>Saldo akhir tersedia / reserved</dt><dd>{stmt.closing.available} / {stmt.closing.reserved}</dd>
            <dt>Terpakai per layanan</dt><dd>{Object.entries(stmt.consumedByService).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}</dd>
          </dl>
        )}
      </div>

      <div className="card">
        <h2>Ledger ({data.ledger.length})</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Jenis</th><th className="r">Avail</th><th className="r">Rsv</th><th className="r">Used</th><th className="r">Exp</th><th>Keterangan</th><th>Waktu</th></tr></thead>
          <tbody>{data.ledger.map((t: any) => (
            <tr key={t.id}><td className="mono">{t.id}</td><td><Badge s={t.type} /></td><td className="r">{d(t.dAvailable)}</td><td className="r">{d(t.dReserved)}</td><td className="r">{d(t.dConsumed)}</td><td className="r">{d(t.dExpired)}</td>
              <td>{t.srCode ? <b className="mono">{t.srCode} </b> : null}{t.reason}<div className="sub">{t.createdByName ?? 'sistem'}</div></td><td className="sub">{dt(t.createdAt)}</td></tr>))}</tbody></table></div>
      </div>
    </>
  );
}
