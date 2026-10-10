'use client';
import { useEffect, useState } from 'react';
import { api, idr, newKey } from '@/lib/api';
import { ErrorBox, Field, useAction, useMe } from './ui';

const ROLES = [['pm', 'Project Manager'], ['lead', 'Lead'], ['senior', 'Senior'], ['junior', 'Junior'], ['forensic', 'Forensic'], ['soc_l1', 'SOC L1'], ['soc_l2', 'SOC L2'], ['cti', 'CTI Analyst']];

export default function PricingPanel({ opp, assessments, scenarios, onDone }: { opp: any; assessments: any[]; scenarios: any[]; onDone: (quotationId?: string) => void }) {
  const me = useMe();
  const reviewed = assessments.filter((a) => a.status === 'REVIEWED');
  const [assessmentId, setAssessmentId] = useState<string>(reviewed[0]?.id ?? '');
  const [inp, setInp] = useState<any>({ clientTier: opp.clientTier, urgency: 'normal', hr: [], commission: 0, thirdParty: 0, travel: 0, recurringCost: 0, selectedBasis: 'standard', discountPct: 0 });
  const [label, setLabel] = useState('Standard');
  const [preview, setPreview] = useState<any>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [cmp, setCmp] = useState<any>(null);
  const act = useAction();
  const showCost = me?.permissions.includes('pricing.view_cost');

  // Isi HR otomatis dari assessment VAPT yang sudah direview
  useEffect(() => {
    const a = reviewed.find((x) => x.id === assessmentId);
    if ((a?.serviceType === 'VAPT' || a?.serviceType === 'GRC') && a.result?.team && a.result.totalMd > 0) {
      const t = a.result.team;
      setInp((p: any) => ({ ...p, hr: [{ role: 'pm', md: t.pm }, { role: 'lead', md: t.lead }, { role: 'senior', md: t.senior }, { role: 'junior', md: t.junior }], referencePrice: undefined,
        addOnPrice: a.serviceType === 'GRC' ? Number(a.result.pdpValue ?? 0) : 0 }));
    } else if (a?.serviceType === 'GRC') {
      setInp((p: any) => ({ ...p, hr: [], referencePrice: undefined, addOnPrice: Number(a.result.pdpValue ?? 0) }));
    } else if (a?.serviceType === 'SOC' || a?.serviceType === 'CTI') {
      setInp((p: any) => ({ ...p, hr: [], referencePrice: Number(a.result.contractValue), addOnPrice: 0 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentId]);

  // Kalkulasi live (debounce)
  useEffect(() => {
    const t = setTimeout(() => {
      const body = { ...inp, hr: inp.hr.filter((h: any) => h.md > 0) };
      if (!body.hr.length && body.referencePrice === undefined && !body.recurringCost && !body.thirdParty && !body.addOnPrice) { setPreview(null); return; }
      api('/api/v1/pricing/calculate', { body }).then(setPreview).catch((e) => setPreview({ error: e.message }));
    }, 400);
    return () => clearTimeout(t);
  }, [inp]);

  const set = (p: any) => setInp({ ...inp, ...p });
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const save = () => act.run(async () => {
    await api('/api/v1/pricing/scenarios', { body: { opportunityId: opp.id, assessmentId: assessmentId || undefined, label, input: { ...inp, hr: inp.hr.filter((h: any) => h.md > 0) } } });
    onDone();
  });
  const toQuotation = (scenarioId: string) => act.run(async () => {
    const q = await api('/api/v1/quotations', { body: { opportunityId: opp.id, scenarioId, title: opp.name }, idempotencyKey: newKey() });
    onDone(q.id);
  });
  const [sim, setSim] = useState<any>(null);
  const [competitor, setCompetitor] = useState('');
  const runSim = () => act.run(async () => setSim(await api('/api/v1/pricing/simulate', { body: { base: { ...inp, hr: inp.hr.filter((h: any) => h.md > 0) }, competitorPrice: competitor ? Number(competitor) : undefined } })));
  const runCompare = () => act.run(async () => setCmp(await api(`/api/v1/pricing/scenarios/compare?ids=${compare.join(',')}`)));

  return (
    <div className="card">
      <h2>Pricing engine & BoQ</h2>
      <ErrorBox error={act.error} />
      {preview?.policy && preview.policy.status !== 'ACTIVE' && <div className="alert warn">Kebijakan {preview.policy.code} v{preview.policy.version} berstatus {preview.policy.status} — belum disahkan owner untuk transaksi produksi.</div>}
      <div className="grid g3">
        <Field label="Assessment (sudah direview)"><select value={assessmentId} onChange={(e) => setAssessmentId(e.target.value)}>
          <option value="">— input manual —</option>{reviewed.map((a) => <option key={a.id} value={a.id}>{a.serviceType} · {a.result?.totalMd ? `${a.result.totalMd} MD` : a.result?.effectiveEps ? `${a.result.effectiveEps} EPS` : a.result?.tier?.label ?? ''}</option>)}</select></Field>
        <Field label="Client tier"><select value={inp.clientTier} onChange={(e) => set({ clientTier: e.target.value })}>{['S', 'A', 'B', 'C', 'D', 'E'].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Urgensi"><select value={inp.urgency} onChange={(e) => set({ urgency: e.target.value })}><option value="normal">Normal</option><option value="priority">Prioritas</option><option value="rush">Rush (&lt;2 minggu)</option></select></Field>
      </div>
      {showCost && (
        <details open>
          <summary>BoQ internal (A–E) — RAHASIA</summary>
          <h3 style={{ marginTop: 8 }}>A. Human resources (MD)</h3>
          {inp.hr.map((h: any, i: number) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <select style={{ flex: 2 }} value={h.role} onChange={(e) => { const hr = [...inp.hr]; hr[i] = { ...h, role: e.target.value }; set({ hr }); }}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <input style={{ flex: 1 }} type="number" min={0} step={0.5} value={h.md} onChange={(e) => { const hr = [...inp.hr]; hr[i] = { ...h, md: num(e.target.value) }; set({ hr }); }} aria-label="Man-days" />
              <button type="button" className="btn bad sm" onClick={() => set({ hr: inp.hr.filter((_: any, j: number) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="btn sec sm" onClick={() => set({ hr: [...inp.hr, { role: 'senior', md: 1 }] })}>+ Role</button>
          <div className="grid g3" style={{ marginTop: 8 }}>
            <Field label="B. Komisi sales/partner (Rp)"><input type="number" min={0} value={inp.commission} onChange={(e) => set({ commission: num(e.target.value) })} /></Field>
            <Field label="C. Dokumen (kosong = default)"><input type="number" min={0} value={inp.documents ?? ''} onChange={(e) => set({ documents: e.target.value === '' ? undefined : num(e.target.value) })} /></Field>
            <Field label="D. Third party / tools (Rp)"><input type="number" min={0} value={inp.thirdParty} onChange={(e) => set({ thirdParty: num(e.target.value) })} /></Field>
            <Field label="D. Langganan/vendor kontrak (Rp)"><input type="number" min={0} value={inp.recurringCost} onChange={(e) => set({ recurringCost: num(e.target.value) })} /></Field>
            <Field label="E. Travel & akomodasi (Rp)"><input type="number" min={0} value={inp.travel} onChange={(e) => set({ travel: num(e.target.value) })} /></Field>
          </div>
        </details>
      )}
      <div className="grid g3">
        <Field label="Basis harga"><select value={inp.selectedBasis} onChange={(e) => set({ selectedBasis: e.target.value })}><option value="floor">Floor</option><option value="standard">Standard</option><option value="premium">Premium</option><option value="manual">Manual</option></select></Field>
        {inp.selectedBasis === 'manual' && <Field label="Harga manual (Rp)"><input type="number" min={0} value={inp.manualPrice ?? 0} onChange={(e) => set({ manualPrice: num(e.target.value) })} /></Field>}
        <Field label="Diskon (%)"><input type="number" min={0} max={99} step={0.5} value={inp.discountPct} onChange={(e) => set({ discountPct: num(e.target.value) })} /></Field>
      </div>
      {preview?.error && <div className="alert bad">{preview.error}</div>}
      {preview && !preview.error && (
        <div className="card" style={{ background: '#fafbfd' }}>
          {preview.warnings?.map((w: string) => <div key={w} className={`alert ${/hold|Floor/.test(w) ? 'bad' : 'warn'}`}>{w}</div>)}
          <div className="grid g4">
            {showCost && <div><div className="sub">Total biaya</div><b>{idr(preview.boq.totalCost)}</b></div>}
            {showCost && <div><div className="sub">Floor</div><b>{idr(preview.prices.floor)}</b></div>}
            <div><div className="sub">Standard</div><b>{idr(preview.prices.standard)}</b></div>
            <div><div className="sub">Premium</div><b>{idr(preview.prices.premium)}</b></div>
            <div><div className="sub">Harga jual (ex-PPN)</div><b>{idr(preview.sellingPrice)}</b></div>
            {showCost && <div><div className="sub">Gross margin / markup</div><b>{preview.grossMarginPct}% / {preview.markupPct ?? '—'}%</b></div>}
            <div><div className="sub">PPN {preview.taxRatePct}%</div><b>{idr(preview.taxAmount)}</b></div>
            <div><div className="sub">Total</div><b>{idr(preview.grandTotal)}</b></div>
          </div>
          {showCost && <div className="sub" style={{ marginTop: 6 }}>DAI {preview.dai} · tier ×{preview.tierMultiplier} · {preview.delivery} · margin = laba/harga jual, markup = laba/biaya</div>}
        </div>
      )}
      <div className="row">
        <input style={{ maxWidth: 220 }} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label scenario" />
        <button type="button" className="btn" disabled={act.busy || !preview || preview.error} onClick={save}>Simpan scenario</button>
      </div>
      {showCost && preview && !preview.error && (
        <details style={{ marginTop: 12 }}>
          <summary>Simulasi sensitivitas (diskon, effort, FX, tier, staffing mix, kompetitor)</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ maxWidth: 220 }} type="number" min={0} placeholder="Harga kompetitor (Rp, opsional)" value={competitor} onChange={(e) => setCompetitor(e.target.value)} aria-label="Harga kompetitor" />
            <button type="button" className="btn sec sm" disabled={act.busy} onClick={runSim}>Jalankan simulasi</button>
          </div>
          {sim && <div className="table-wrap" style={{ marginTop: 8 }}><table className="t"><thead><tr><th>Variasi</th><th className="r">Biaya</th><th className="r">Harga jual</th><th className="r">Margin</th>{sim.competitorPrice && <th className="r">vs kompetitor</th>}</tr></thead><tbody>
            {sim.rows.map((r: any, i: number) => (
              <tr key={i} style={{ background: r.marginHold || r.belowFloor ? 'var(--bad-soft)' : undefined }}>
                <td>{({ base: 'Dasar', discountPct: 'Diskon %', effortFactor: 'Effort ×', fxIndex: 'Indeks FX', clientTier: 'Tier', staffingMix: 'Staffing' } as Record<string, string>)[r.dimension]} {r.dimension !== 'base' ? r.value : ''}</td>
                <td className="r">{idr(r.totalCost)}</td><td className="r">{idr(r.sellingPrice)}</td><td className="r">{r.grossMarginPct}%</td>
                {sim.competitorPrice && <td className="r">{r.vsCompetitorPct > 0 ? '+' : ''}{r.vsCompetitorPct}%</td>}
              </tr>))}
          </tbody></table></div>}
        </details>
      )}
      {scenarios.length > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Scenario tersimpan</h3>
          <div className="table-wrap"><table className="t"><thead><tr><th></th><th>Label</th><th className="r">Harga jual</th><th className="r">Margin</th><th></th></tr></thead><tbody>
            {scenarios.map((s) => (
              <tr key={s.id}>
                <td><input type="checkbox" style={{ width: 18, minHeight: 18 }} checked={compare.includes(s.id)} onChange={(e) => setCompare(e.target.checked ? [...compare, s.id] : compare.filter((x) => x !== s.id))} aria-label="Bandingkan" /></td>
                <td>{s.label}</td><td className="r">{idr(s.result.sellingPrice)}</td><td className="r">{s.result.grossMarginPct}%</td>
                <td className="r">{me?.permissions.includes('quotation.write') && <button className="btn pur sm" disabled={act.busy} onClick={() => toQuotation(s.id)}>Buat quotation</button>}</td>
              </tr>
            ))}
          </tbody></table></div>
          {compare.length >= 2 && <button className="btn sec sm" onClick={runCompare}>Bandingkan {compare.length} scenario</button>}
          {cmp && <div className="table-wrap" style={{ marginTop: 8 }}><table className="t"><thead><tr><th>Metrik</th>{cmp.items.map((c: any) => <th key={c.id} className="r">{c.label}</th>)}</tr></thead><tbody>
            {[['totalCost', 'Biaya'], ['floor', 'Floor'], ['standard', 'Standard'], ['sellingPrice', 'Harga jual'], ['discountPct', 'Diskon %'], ['grossMarginPct', 'Margin %'], ['markupPct', 'Markup %'], ['grandTotal', 'Total + PPN']].map(([k, l]) => (
              <tr key={k}><td>{l}</td>{cmp.items.map((c: any) => <td key={c.id} className="r">{/Pct/.test(k) ? `${c[k]}%` : idr(c[k])}</td>)}</tr>))}
          </tbody></table></div>}
        </>
      )}
    </div>
  );
}
