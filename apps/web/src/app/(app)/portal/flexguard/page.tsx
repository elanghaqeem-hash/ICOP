'use client';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '@/components/ui';

export default function PortalFlexGuard() {
  const { data, error, loading, reload } = useApi('/api/v1/portal/flexguard');
  const act = useAction();
  const [ledger, setLedger] = useState<Record<string, any>>({});
  const [sr, setSr] = useState({ walletId: '', serviceLine: '', title: '', description: '' });
  const [dispute, setDispute] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const active = data.wallets.filter((w: any) => w.status === 'ACTIVE');
  const call = (path: string, body: any, ok: string) => act.run(async () => { await api(`/api/v1/portal/flexguard/requests/${path}`, { body, idempotencyKey: newKey() }); setMsg(ok); reload(); });
  return (
    <>
      <PageHead title="FlexGuard Token" sub="Saldo token, permintaan layanan & persetujuan Anda" />
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      {data.wallets.length ? data.wallets.map((w: any) => {
        const pct = Number(w.creditedTokens) ? Math.round((Number(w.availableTokens) / Number(w.creditedTokens)) * 100) : 0;
        return (
          <div key={w.id} className="card">
            <div className="row"><b className="mono">{w.code}</b><span className="sub">{w.package}</span><span className="spacer" /><Badge s={w.status} /></div>
            <div className="grid g3" style={{ marginTop: 6 }}>
              <div className="kpi"><div className="l">Tersedia</div><div className="v">{Number(w.availableTokens)}</div><div className="l">dari {Number(w.creditedTokens)} ({pct}%)</div></div>
              <div className="kpi"><div className="l">Dicadangkan / terpakai</div><div className="v">{Number(w.reservedTokens)} / {Number(w.consumedTokens)}</div><div className="l">hangus {Number(w.expiredTokens)}</div></div>
              <div className="kpi"><div className="l">Berlaku s/d</div><div className="v">{String(w.validUntil).slice(0, 10)}</div><div className="l">{idr(w.pricePerToken)}/token</div></div>
            </div>
            <div className="bar"><span style={{ width: `${pct}%` }} /></div>
            {Array.isArray(w.complimentary) && w.complimentary.length > 0 && <div className="sub" style={{ marginTop: 6 }}>Complimentary: {w.complimentary.map((c: any) => `${c.item} (${c.status === 'AVAILABLE' ? `tukar s/d ${c.redeemBy}` : c.status})`).join(' · ')}</div>}
            <button className="btn sec sm" style={{ marginTop: 6 }} disabled={act.busy} onClick={() => act.run(async () => setLedger({ ...ledger, [w.id]: ledger[w.id] ? null : await api(`/api/v1/portal/flexguard/wallets/${w.id}/ledger`) }))}>{ledger[w.id] ? 'Tutup mutasi' : 'Lihat mutasi'}</button>
            {ledger[w.id] && <div className="table-wrap" style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Waktu</th><th>Jenis</th><th className="r">Tersedia</th><th className="r">Terpakai</th><th>Keterangan</th></tr></thead>
              <tbody>{ledger[w.id].ledger.map((t: any) => <tr key={t.id}><td className="sub">{dt(t.createdAt)}</td><td><Badge s={t.type} /></td><td className="r">{Number(t.dAvailable) || ''}</td><td className="r">{Number(t.dConsumed) || ''}</td><td>{t.srCode ? <b className="mono">{t.srCode} </b> : null}{t.reason}</td></tr>)}</tbody></table></div>}
          </div>
        );
      }) : <div className="card empty">Belum ada wallet FlexGuard</div>}

      <div className="card">
        <h2>Permintaan layanan</h2>
        {data.requests.length ? data.requests.map((s: any) => (
          <div key={s.id} className="list-item">
            <div className="row"><b className="mono">{s.code}</b><span className="sub">{s.serviceLine}</span><span className="spacer" /><Badge s={s.status} /></div>
            <div className="sub">{s.title} · estimasi {s.estimatedTokens ?? '—'} · aktual {s.actualTokens ?? '—'} token · {dt(s.updatedAt)}</div>
            {s.status === 'PENDING_CUSTOMER_APPROVAL' && (
              <div className="row" style={{ marginTop: 6 }}>
                <span className="sub">Setujui estimasi {s.estimatedTokens} token? Token akan dicadangkan.</span>
                <button className="btn ok sm" disabled={act.busy} onClick={() => call(`${s.id}/approve`, {}, `${s.code} disetujui — ${s.estimatedTokens} token dicadangkan`)}>Setujui estimasi</button>
              </div>
            )}
            {s.status === 'DELIVERED' && (
              <div style={{ marginTop: 6 }}>
                <div className="sub">Hasil diserahkan: {s.deliverableRef ?? '—'} · realisasi {s.actualTokens} token (dicadangkan {Number(s.reservedTokens)}).</div>
                <div className="row" style={{ marginTop: 4 }}>
                  <button className="btn ok sm" disabled={act.busy} onClick={() => { if (window.confirm(`Terima hasil ${s.code} (BAST)? ${s.actualTokens} token akan didebit.`)) call(`${s.id}/accept`, {}, `${s.code} diterima`); }}>Terima (BAST)</button>
                </div>
                <Field label="Ajukan keberatan"><input value={dispute[s.id] ?? ''} onChange={(e) => setDispute({ ...dispute, [s.id]: e.target.value })} placeholder="Jelaskan keberatan (min. 10 karakter)" /></Field>
                <button className="btn bad sm" disabled={act.busy || (dispute[s.id] ?? '').length < 10} onClick={() => call(`${s.id}/dispute`, { note: dispute[s.id] }, 'Keberatan dikirim ke Account Manager')}>Kirim keberatan</button>
              </div>
            )}
          </div>
        )) : <div className="empty">Belum ada</div>}
      </div>

      {active.length > 0 && (
        <div className="card">
          <h2>Ajukan permintaan layanan</h2>
          <p className="sub">Layanan yang dapat didebit token: {data.serviceLines.join(', ')}. Tim kami akan mengirim estimasi token untuk Anda setujui.</p>
          <div className="grid g2">
            <Field label="Wallet"><select value={sr.walletId || active[0].id} onChange={(e) => setSr({ ...sr, walletId: e.target.value })}>{active.map((w: any) => <option key={w.id} value={w.id}>{w.code} ({Number(w.availableTokens)} token)</option>)}</select></Field>
            <Field label="Layanan"><select value={sr.serviceLine || data.serviceLines[0]} onChange={(e) => setSr({ ...sr, serviceLine: e.target.value })}>{data.serviceLines.map((s: string) => <option key={s}>{s}</option>)}</select></Field>
          </div>
          <Field label="Judul"><input value={sr.title} onChange={(e) => setSr({ ...sr, title: e.target.value })} /></Field>
          <Field label="Deskripsi kebutuhan"><textarea value={sr.description} onChange={(e) => setSr({ ...sr, description: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy || sr.title.length < 3} onClick={() => act.run(async () => {
            const r = await api('/api/v1/portal/flexguard/requests', { body: { walletId: sr.walletId || active[0].id, serviceLine: sr.serviceLine || data.serviceLines[0], title: sr.title, description: sr.description || undefined } });
            setMsg(`Permintaan ${r.code} terkirim`); setSr({ walletId: '', serviceLine: '', title: '', description: '' }); reload();
          })}>Kirim permintaan</button>
        </div>
      )}
    </>
  );
}
