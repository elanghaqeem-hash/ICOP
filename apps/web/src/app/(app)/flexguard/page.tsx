'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, idr, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

type Tab = 'wallets' | 'requests' | 'calc';

export default function FlexGuard() {
  const me = useMe();
  const [tab, setTab] = useState<Tab>('wallets');
  const canCalc = !!me?.permissions.includes('pricing.calculate');
  return (
    <>
      <PageHead title="FlexGuard Token" sub="Wallet token, service request & kalkulator paket (FLEXGUARD-PD1)" />
      <PolicyApproval />
      <div className="row" style={{ marginBottom: 10 }} role="tablist">
        <button className={`btn sm ${tab === 'wallets' ? '' : 'sec'}`} onClick={() => setTab('wallets')}>Wallet</button>
        <button className={`btn sm ${tab === 'requests' ? '' : 'sec'}`} onClick={() => setTab('requests')}>Service request</button>
        {canCalc && <button className={`btn sm ${tab === 'calc' ? '' : 'sec'}`} onClick={() => setTab('calc')}>Kalkulator</button>}
      </div>
      {tab === 'wallets' && <Wallets />}
      {tab === 'requests' && <Requests />}
      {tab === 'calc' && canCalc && <Calculator />}
    </>
  );
}

function Wallets() {
  const { data, error, loading } = useApi('/api/v1/flexguard/wallets');
  return (
    <>
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((w: any) => {
          const pct = Number(w.creditedTokens) ? Math.round((Number(w.availableTokens) / Number(w.creditedTokens)) * 100) : 0;
          return (
            <Link key={w.id} href={`/flexguard/${w.id}`} className="list-item">
              <div className="row"><b className="mono">{w.code}</b><span className="sub">{w.package}</span><span className="spacer" /><Badge s={w.status} /></div>
              <div className="sub">{w.customerName} · kontrak {w.contractNumber ?? '—'} · s/d {String(w.validUntil).slice(0, 10)}</div>
              <div className="sub">Tersedia <b>{Number(w.availableTokens)}</b> / {Number(w.creditedTokens)} token ({pct}%) · reserved {Number(w.reservedTokens)} · terpakai {Number(w.consumedTokens)}</div>
              <div className="bar" aria-hidden><span style={{ width: `${pct}%` }} /></div>
            </Link>
          );
        }) : <div className="empty">Belum ada wallet. Wallet dibuat otomatis saat kontrak FLEXGUARD diaktifkan.</div>}
      </div>}
    </>
  );
}

function Requests() {
  const [status, setStatus] = useState('');
  const { data, error, loading } = useApi(`/api/v1/flexguard/requests${status ? `?status=${status}` : ''}`, [status]);
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter status" style={{ maxWidth: 260 }}>
          <option value="">Semua status</option>
          {['SUBMITTED', 'SCOPED', 'PENDING_CUSTOMER_APPROVAL', 'APPROVED', 'IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'COMPLETED', 'CANCELLED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
      </div>
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((s: any) => (
          <Link key={s.id} href={`/flexguard/requests/${s.id}`} className="list-item">
            <div className="row"><b className="mono">{s.code}</b><span className="spacer" /><Badge s={s.status} /></div>
            <div className="sub">{s.title} · {s.serviceLine} · {s.customerName} ({s.walletCode})</div>
            <div className="sub">Estimasi {s.estimatedTokens ?? '—'} · reserved {Number(s.reservedTokens)} · aktual {s.actualTokens ?? '—'} · {dt(s.updatedAt)}</div>
          </Link>
        )) : <div className="empty">Belum ada service request</div>}
      </div>}
    </>
  );
}

function Calculator() {
  const pol = useApi('/api/v1/flexguard/policy');
  const act = useAction();
  const [tokens, setTokens] = useState(100);
  const [price, setPrice] = useState('');
  const [months, setMonths] = useState('');
  const [usage, setUsage] = useState<{ serviceLine: string; role: string; md: number; timesPerYear: number; overseas: boolean; rush: boolean }[]>([]);
  const [res, setRes] = useState<any>(null);
  if (pol.loading || !pol.data) return <div className="card"><ErrorBox error={pol.error} /><Loading /></div>;
  const p = pol.data;
  const roles = Object.keys(p.tdc);
  const run = () => act.run(async () => {
    setRes(await api('/api/v1/flexguard/calculate', { body: {
      tokens, pricePerToken: price ? Number(price) : undefined, contractMonths: months ? Number(months) : undefined,
      plannedUsage: usage.filter((u) => u.md > 0).map((u) => ({ serviceLine: u.serviceLine, lines: [{ role: u.role, md: u.md }], timesPerYear: u.timesPerYear, overseas: u.overseas, rush: u.rush })),
    } }));
  });
  return (
    <>
      <div className="card">
        <h2>Kalkulator paket</h2>
        <p className="sub">Kebijakan {p.code} v{p.version} · <Badge s={p.status} /> · TRV {idr(p.trv)}/token</p>
        {p.status !== 'ACTIVE' && <div className="alert warn">Parameter FlexGuard masih menunggu persetujuan Owner/Finance. Hasil kalkulasi bersifat indikatif.</div>}
        <div className="grid g3">
          <Field label="Jumlah token"><input type="number" min={1} value={tokens} onChange={(e) => setTokens(Number(e.target.value))} /></Field>
          <Field label="Harga khusus/token (opsional)"><input type="number" min={0} value={price} placeholder="ikuti ladder" onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label="Masa berlaku (bulan, opsional)"><input type="number" min={1} max={60} value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
        </div>
        <h3>Rencana pemakaian (opsional)</h3>
        {usage.map((u, i) => (
          <div key={i} className="grid g3" style={{ borderTop: '1px solid #eef0f5', paddingTop: 6 }}>
            <Field label="Layanan"><select value={u.serviceLine} onChange={(e) => { const x = [...usage]; x[i] = { ...u, serviceLine: e.target.value }; setUsage(x); }}>{p.serviceLines.map((s: string) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Peran"><select value={u.role} onChange={(e) => { const x = [...usage]; x[i] = { ...u, role: e.target.value }; setUsage(x); }}>{roles.map((r) => <option key={r} value={r}>{r} (TDC {p.tdc[r]})</option>)}</select></Field>
            <Field label="MD / kali"><input type="number" min={0} step={0.5} value={u.md} onChange={(e) => { const x = [...usage]; x[i] = { ...u, md: Number(e.target.value) }; setUsage(x); }} /></Field>
            <Field label="Frekuensi / tahun"><input type="number" min={0} max={52} value={u.timesPerYear} onChange={(e) => { const x = [...usage]; x[i] = { ...u, timesPerYear: Number(e.target.value) }; setUsage(x); }} /></Field>
            <label className="check"><input type="checkbox" checked={u.overseas} onChange={(e) => { const x = [...usage]; x[i] = { ...u, overseas: e.target.checked }; setUsage(x); }} /> Overseas</label>
            <div className="row"><label className="check"><input type="checkbox" checked={u.rush} onChange={(e) => { const x = [...usage]; x[i] = { ...u, rush: e.target.checked }; setUsage(x); }} /> Rush</label>
              <button className="btn sec sm" onClick={() => setUsage(usage.filter((_, j) => j !== i))}>Hapus</button></div>
          </div>
        ))}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn sec sm" onClick={() => setUsage([...usage, { serviceLine: p.serviceLines[0], role: 'senior', md: 5, timesPerYear: 1, overseas: false, rush: false }])}>+ Baris pemakaian</button>
          <span className="spacer" />
          <button className="btn" disabled={act.busy || tokens <= 0} onClick={run}>Hitung</button>
        </div>
        <ErrorBox error={act.error} />
      </div>
      {res && (
        <div className="card" data-testid="calc-result">
          <h2>Hasil: paket {res.package}{res.specialDeal ? ' (harga khusus)' : ''}</h2>
          {res.warnings.map((w: string, i: number) => <div key={i} className="alert warn">{w}</div>)}
          <div className="grid g3">
            <div className="kpi"><div className="l">Harga/token</div><div className="v">{idr(res.pricePerToken)}</div><div className="l">list {idr(res.listPricePerToken)} · diskon vs TRV {res.discountVsTrvPct}%</div></div>
            <div className="kpi"><div className="l">Token</div><div className="v">{res.totalTokens}</div><div className="l">{res.tokens} + bonus {res.bonusTokens} · {res.validMonths} bln{res.rollover ? ' · rollover' : ''}</div></div>
            <div className="kpi"><div className="l">Total (incl. PPN {res.taxRatePct}%)</div><div className="v">{idr(res.total)}</div><div className="l">subtotal {idr(res.subtotal)}</div></div>
          </div>
          <div className="sub" style={{ marginTop: 6 }}>Floor/token {idr(res.floorPerToken)}{res.belowFloor ? ' — DI BAWAH FLOOR' : ''} · membership {res.membership ?? '—'} · complimentary: {res.complimentary.join(', ') || '—'}</div>
          {res.plannedUsage.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 8 }}><table className="t"><thead><tr><th>Layanan</th><th>Token/kali</th><th>×/thn</th><th>Token/thn</th><th>Nilai efektif</th><th>Floor</th></tr></thead>
              <tbody>{res.plannedUsage.map((u: any, i: number) => <tr key={i}><td>{u.serviceLine}</td><td>{u.tokensPerRun}</td><td>{u.timesPerYear}</td><td>{u.tokensPerYear}</td><td>{idr(u.effectiveCostPerRun)}</td><td>{u.belowFloor ? <span className="badge bad">di bawah</span> : <span className="badge ok">OK</span>}</td></tr>)}</tbody></table></div>
          )}
          {res.monthsToDeplete !== null && <div className="sub" style={{ marginTop: 6 }}>Pemakaian {res.tokensPerYear} token/thn → habis dalam {res.monthsToDeplete} bln{res.topUpRecommendation > 0 ? ` · rekomendasi top-up ${res.topUpRecommendation} token` : ''}</div>}
        </div>
      )}
    </>
  );
}

/** Pengesahan kebijakan FlexGuard: tombol hanya untuk Direktur & Company Admin (perm policy.activate). */
function PolicyApproval() {
  const pol = useApi('/api/v1/flexguard/policy');
  const act = useAction();
  const [note, setNote] = useState('');
  const [done, setDone] = useState('');
  if (!pol.data) return null;
  if (pol.data.status === 'ACTIVE') return done ? <div className="alert ok">{done}</div> : null;
  return (
    <div className="card" style={{ borderColor: '#f0c36d' }} data-testid="flexguard-approval">
      <div className="row"><h2 style={{ margin: 0 }}>Kebijakan {pol.data.code} v{pol.data.version}</h2><span className="spacer" /><Badge s={pol.data.status} label="MENUNGGU PENGESAHAN" /></div>
      <p className="sub">Parameter (TRV {idr(pol.data.trv)}/token, ladder paket, TDC, floor) berasal dari dokumen FlexGuard_Token. Kalkulasi bersifat indikatif sampai disahkan Direktur atau Company Admin.</p>
      {pol.data.canApprove ? (
        <>
          <ErrorBox error={act.error} />
          <Field label="Catatan pengesahan (min. 10 karakter)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Parameter ditinjau Finance & disetujui" /></Field>
          <button className="btn ok" disabled={act.busy || note.length < 10} onClick={() => act.run(async () => {
            const r = await api('/api/v1/flexguard/policy/approve', { body: { note } });
            setDone(`${r.code} v${r.version} disahkan dan berlaku.`); pol.reload();
          })}>Sahkan kebijakan FlexGuard</button>
        </>
      ) : <div className="sub">Menunggu pengesahan Direktur atau Company Admin.</div>}
    </div>
  );
}
