'use client';
import { useState } from 'react';
import { api, idr } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function Vendors() {
  const me = useMe();
  const { data, error, loading, reload } = useApi('/api/v1/vendors');
  const [sel, setSel] = useState<string | null>(null);
  const prices = useApi(sel ? `/api/v1/vendors/${sel}/prices` : null, [sel]);
  const [nv, setNv] = useState<any>({ name: '', vendorType: 'distributor', authorizationStatus: 'NONE', authorizedUntil: '', partnerLevel: '' });
  const [np, setNp] = useState<any>({ sku: '', description: '', unit: 'unit', currency: 'IDR', unitCost: 0, fxRateToIdr: 1, validFrom: new Date().toISOString().slice(0, 10), validUntil: '', isSpecialBid: false });
  const [bom, setBom] = useState<Record<string, { qty: number; periods: number }>>({});
  const [margin, setMargin] = useState(20);
  const [bomRes, setBomRes] = useState<any>(null);
  const act = useAction();
  const w = me?.permissions.includes('vendor.write');
  const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  return (
    <>
      <PageHead title="Vendor, distributor & BOM" sub="Price list berversi dengan masa berlaku dan kurs; BOM builder menghitung biaya & harga jual" />
      <ErrorBox error={act.error ?? error} />
      {w && (
        <details className="card"><summary>+ Vendor / distributor</summary>
          <div className="grid g3" style={{ marginTop: 8 }}>
            <Field label="Nama"><input value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} /></Field>
            <Field label="Tipe"><select value={nv.vendorType} onChange={(e) => setNv({ ...nv, vendorType: e.target.value })}>{['vendor', 'distributor', 'vendor_distributor', 'subcontractor'].map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Level partner"><input value={nv.partnerLevel} onChange={(e) => setNv({ ...nv, partnerLevel: e.target.value })} /></Field>
            <Field label="Otorisasi"><select value={nv.authorizationStatus} onChange={(e) => setNv({ ...nv, authorizationStatus: e.target.value })}>{['NONE', 'REGISTERED', 'AUTHORIZED'].map((x) => <option key={x}>{x}</option>)}</select></Field>
            <Field label="Otorisasi berlaku s/d"><input type="date" value={nv.authorizedUntil} onChange={(e) => setNv({ ...nv, authorizedUntil: e.target.value })} /></Field>
          </div>
          <button className="btn sm" disabled={nv.name.length < 2 || act.busy} onClick={() => act.run(async () => { await api('/api/v1/vendors', { body: strip(nv) }); setNv({ ...nv, name: '' }); reload(); })}>Simpan</button>
        </details>
      )}
      {loading ? <Loading /> : (
        <div className="card" style={{ padding: 0 }}>
          {data?.items.length ? data.items.map((v: any) => (
            <button key={v.id} className="list-item" style={{ width: '100%', textAlign: 'left', border: 'none', background: sel === v.id ? 'var(--purple-soft)' : 'transparent', cursor: 'pointer' }} onClick={() => setSel(v.id)}>
              <div className="row"><b>{v.name}</b><span className="sub">{v.code} · {v.vendorType}{v.partnerLevel ? ` · ${v.partnerLevel}` : ''}</span><span className="spacer" /><Badge s={v.effectiveAuthorization} /></div>
              <div className="sub">{v.activePrices} harga berlaku{v.authorizedUntil ? ` · otorisasi s/d ${String(v.authorizedUntil).slice(0, 10)}` : ''}</div>
            </button>)) : <div className="empty">Belum ada vendor</div>}
        </div>
      )}
      {sel && (
        <div className="card">
          <h2>Price list</h2>
          {prices.data?.items.length ? <div className="table-wrap"><table className="t"><thead><tr><th></th><th>SKU</th><th>Deskripsi</th><th className="r">Biaya</th><th className="r">IDR</th><th>Berlaku</th><th className="r">Qty BOM</th></tr></thead><tbody>
            {prices.data.items.map((p: any) => (
              <tr key={p.id} style={{ opacity: p.isValid ? 1 : 0.55 }}>
                <td><input type="checkbox" style={{ width: 18, minHeight: 18 }} checked={!!bom[p.id]} onChange={(e) => { const b = { ...bom }; if (e.target.checked) b[p.id] = { qty: 1, periods: 1 }; else delete b[p.id]; setBom(b); }} aria-label="Masukkan BOM" /></td>
                <td className="mono">{p.sku}{p.isSpecialBid && <> <span className="badge warn">special bid</span></>}</td><td>{p.description}</td>
                <td className="r">{p.currency} {Number(p.unitCost).toLocaleString('id-ID')}</td><td className="r">{idr(p.unitCostIdr)}</td>
                <td>{String(p.validFrom).slice(0, 10)} – {p.validUntil ? String(p.validUntil).slice(0, 10) : '∞'}</td>
                <td className="r">{bom[p.id] && <input type="number" min={1} style={{ width: 70 }} value={bom[p.id].qty} onChange={(e) => setBom({ ...bom, [p.id]: { ...bom[p.id], qty: Number(e.target.value) } })} aria-label="Qty" />}</td>
              </tr>))}
          </tbody></table></div> : <div className="empty">Belum ada harga</div>}
          {w && (
            <details style={{ marginTop: 8 }}><summary>+ Harga / quotation distributor</summary>
              <div className="grid g3" style={{ marginTop: 8 }}>
                {[['sku', 'SKU'], ['description', 'Deskripsi'], ['unit', 'Satuan']].map(([k, l]) => <Field key={k} label={l}><input value={np[k]} onChange={(e) => setNp({ ...np, [k]: e.target.value })} /></Field>)}
                <Field label="Mata uang"><select value={np.currency} onChange={(e) => setNp({ ...np, currency: e.target.value })}>{['IDR', 'USD', 'SGD', 'EUR'].map((c) => <option key={c}>{c}</option>)}</select></Field>
                <Field label="Biaya per unit"><input type="number" min={0} value={np.unitCost} onChange={(e) => setNp({ ...np, unitCost: Number(e.target.value) })} /></Field>
                <Field label="Kurs ke IDR"><input type="number" min={0} value={np.fxRateToIdr} onChange={(e) => setNp({ ...np, fxRateToIdr: Number(e.target.value) })} /></Field>
                <Field label="Berlaku dari"><input type="date" value={np.validFrom} onChange={(e) => setNp({ ...np, validFrom: e.target.value })} /></Field>
                <Field label="Berlaku s/d"><input type="date" value={np.validUntil} onChange={(e) => setNp({ ...np, validUntil: e.target.value })} /></Field>
                <label className="check"><input type="checkbox" checked={np.isSpecialBid} onChange={(e) => setNp({ ...np, isSpecialBid: e.target.checked })} /> Special bid price</label>
              </div>
              <button className="btn sm" disabled={!np.sku || act.busy} onClick={() => act.run(async () => { await api(`/api/v1/vendors/${sel}/prices`, { body: { items: [strip(np)] } }); setNp({ ...np, sku: '', description: '' }); prices.reload(); reload(); })}>Simpan harga</button>
            </details>
          )}
        </div>
      )}
      {Object.keys(bom).length > 0 && me?.permissions.includes('pricing.view_cost') && (
        <div className="card">
          <h2>BOM builder</h2>
          <div className="row"><Field label="Target margin (%)"><input type="number" min={0} max={90} value={margin} onChange={(e) => setMargin(Number(e.target.value))} /></Field>
            <button className="btn" disabled={act.busy} onClick={() => act.run(async () => setBomRes(await api('/api/v1/pricing/bom', { body: { lines: Object.entries(bom).map(([priceItemId, v]) => ({ priceItemId, ...v })), targetMarginPct: margin } })))}>Hitung</button></div>
          {bomRes && <>
            <div className="table-wrap"><table className="t"><thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Biaya</th><th className="r">Harga jual</th></tr></thead><tbody>
              {bomRes.lines.map((l: any) => <tr key={l.priceItemId}><td>{l.description}<div className="sub">{l.vendor}</div>{l.warnings.map((x: string) => <div key={x} className="badge warn">{x}</div>)}</td><td className="r">{l.qty}</td><td className="r">{idr(l.cost)}</td><td className="r">{idr(l.sellingPrice)}</td></tr>)}
              <tr><td colSpan={2}><b>Total</b></td><td className="r"><b>{idr(bomRes.totalCost)}</b></td><td className="r"><b>{idr(bomRes.totalSellingPrice)}</b></td></tr></tbody></table></div>
            <p className="sub">{bomRes.note}</p></>}
        </div>
      )}
    </>
  );
}
