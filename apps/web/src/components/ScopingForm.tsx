'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, ErrorBox, Field, useAction, useMe } from './ui';

const SOC_ASSETS: [string, string][] = [
  ['windows_server', 'Windows Server'], ['linux_server', 'Linux Server'], ['virtual_machine', 'Virtual Machine'], ['firewall', 'Firewall'],
  ['waf', 'WAF'], ['ids_ips', 'IDS/IPS'], ['proxy', 'Web Proxy'], ['email_gateway', 'Email Gateway'], ['network_device', 'Switch/Router core'],
  ['cloud_account', 'Cloud account'], ['web_app', 'Web app (access log)'], ['database', 'Database'], ['edr_unified', 'EDR terpadu (1 sumber)'], ['workstation', 'Workstation (per_device saja)'],
];

const emptyVapt = { web: [] as any[], mobile: [] as any[], api: [] as any[], network: { externalIps: 0, internalHosts: 0, activeDirectory: false, wifiClusters: 0, firewallPolicies: 0, cloudAccounts: 0 },
  webMethod: 'grey', webAuth: 'basic', compliance: 'owasp', includeJunior: true, workLocation: 'remote', assessmentWindow: '', reportingStandard: 'OWASP' };
const emptyCti = { domains: 3, subsidiaries: 0, publicIps: 0, darkWebMonitoring: false, rfiPerMonth: 2, siemIntegration: false, apiIntegration: false, takedownsPerYear: 0, contractMonths: 12, pricePoint: 'mid' };
const emptyGrc: any = { iso: { frameworks: ['iso27001'], employees: 100, locations: 1, scope: 'company', maturity: '2', existingIsms: false, serviceType: 'full' }, pdp: undefined, includeJunior: true };
const emptySoc = { assets: {} as Record<string, number>, method: 'simplified', logSources: 0, coverage: '24x7', serviceTier: 'standard', edrEndpoints: 0, contractMonths: 12,
  includeOnboarding: true, siemPlatform: '', retentionDays: 90 };

export default function ScopingForm({ customerId, opportunityId, existing, onDone }: { customerId: string; opportunityId: string; existing?: any; onDone: () => void }) {
  const me = useMe();
  const [type, setType] = useState<'VAPT' | 'SOC' | 'CTI' | 'GRC'>(existing?.serviceType ?? 'VAPT');
  const [a, setA] = useState<any>(existing?.answers ?? emptyVapt);
  const [rec, setRec] = useState<any>(existing ?? null);
  const [saved, setSaved] = useState<string>('');
  const act = useAction();
  const dirty = useRef(false);

  // Auto-save draft setiap 4 detik bila ada perubahan
  useEffect(() => {
    const t = setInterval(async () => {
      if (!dirty.current || !rec?.id) return;
      dirty.current = false;
      try { const r = await api(`/api/v1/assessments/${rec.id}`, { method: 'PATCH', body: { answers: a } }); setRec(r); setSaved(new Date().toLocaleTimeString('id-ID')); } catch { /* ditampilkan saat simpan manual */ }
    }, 4000);
    return () => clearInterval(t);
  }, [a, rec?.id]);

  const upd = (patch: any) => { dirty.current = true; setA({ ...a, ...patch }); };
  const switchType = (t: 'VAPT' | 'SOC' | 'CTI' | 'GRC') => { if (rec) return; setType(t); setA(t === 'VAPT' ? emptyVapt : t === 'SOC' ? emptySoc : t === 'CTI' ? emptyCti : emptyGrc); };
  const n = (v: string) => (v === '' ? 0 : Number(v));

  const saveAndCalc = () => act.run(async () => {
    let r = rec;
    if (!r) r = await api('/api/v1/assessments', { body: { customerId, opportunityId, serviceType: type, answers: a } });
    else r = await api(`/api/v1/assessments/${r.id}`, { method: 'PATCH', body: { answers: a } });
    r = await api(`/api/v1/assessments/${r.id}/calculate`, { body: {} });
    dirty.current = false; setRec(r); onDone();
  });
  const review = () => act.run(async () => { const r = await api(`/api/v1/assessments/${rec.id}/review`, { body: { note: 'Direview Pre-Sales' } }); setRec(r); onDone(); });

  const listEditor = (key: 'web' | 'mobile' | 'api', blank: any, cols: (row: any, i: number, set: (p: any) => void) => React.ReactNode) => (
    <div style={{ marginBottom: 10 }}>
      {a[key].map((row: any, i: number) => {
        const set = (p: any) => { const arr = [...a[key]]; arr[i] = { ...row, ...p }; upd({ [key]: arr }); };
        return <div key={i} className="card" style={{ background: '#fafbfd', padding: 10 }}>{cols(row, i, set)}
          <button type="button" className="btn bad sm" onClick={() => upd({ [key]: a[key].filter((_: any, j: number) => j !== i) })}>Hapus</button></div>;
      })}
      <button type="button" className="btn sec sm" onClick={() => upd({ [key]: [...a[key], blank] })}>+ Tambah {key === 'web' ? 'web app' : key === 'mobile' ? 'mobile app' : 'API'}</button>
    </div>
  );

  return (
    <div className="card">
      <div className="row"><h2 style={{ margin: 0 }}>Smart Scoping Assessment</h2><span className="spacer" />
        {rec && <><Badge s={rec.status} /><span className="badge">Kelengkapan {rec.completeness}%</span></>}</div>
      {!rec && <div className="tabs" style={{ marginTop: 8 }}>{(['VAPT', 'SOC', 'CTI', 'GRC'] as const).map((t) => <button key={t} type="button" className={type === t ? 'on' : ''} onClick={() => switchType(t)}>{({ VAPT: 'VAPT', SOC: 'SOC / MDR / SIEM', CTI: 'CTI / ETLM', GRC: 'GRC: ISO / PDP' })[t]}</button>)}</div>}
      <div className="alert warn" style={{ marginTop: 8 }}>Jangan isi password, kredensial, atau konfigurasi rahasia pelanggan di form ini.</div>
      <ErrorBox error={act.error} />
      {type === 'VAPT' ? (
        <>
          <details open><summary>Web application ({a.web.length})</summary>
            {listEditor('web', { name: '', complexity: 'medium', roles: 2, apiEndpoints: 0, handlesFinancialData: false }, (r, _i, set) => (
              <div className="grid g2">
                <Field label="Nama aplikasi"><input value={r.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="Kompleksitas"><select value={r.complexity} onChange={(e) => set({ complexity: e.target.value })}>
                  <option value="simple">Simple (≤10 modul)</option><option value="medium">Medium (11–30 modul CRUD)</option><option value="complex">Complex (31–50 + logic)</option><option value="critical">Critical (&gt;50/fintech)</option></select></Field>
                <Field label="Jumlah role user"><input type="number" min={1} inputMode="numeric" value={r.roles} onChange={(e) => set({ roles: n(e.target.value) })} /></Field>
                <Field label="Jumlah API endpoint"><input type="number" min={0} inputMode="numeric" value={r.apiEndpoints} onChange={(e) => set({ apiEndpoints: n(e.target.value) })} /></Field>
                <label className="check"><input type="checkbox" checked={r.handlesFinancialData} onChange={(e) => set({ handlesFinancialData: e.target.checked })} /> Memproses data keuangan/transaksi</label>
              </div>))}
            <div className="grid g3">
              <Field label="Metodologi"><select value={a.webMethod} onChange={(e) => upd({ webMethod: e.target.value })}><option value="black">Black box ×1.0</option><option value="grey">Grey box ×1.2</option><option value="white">White box ×1.5</option></select></Field>
              <Field label="Autentikasi"><select value={a.webAuth} onChange={(e) => upd({ webAuth: e.target.value })}><option value="basic">Basic ×1.0</option><option value="sso">SSO/OAuth2 ×1.1</option><option value="mfa">MFA ×1.2</option><option value="idam">IdAM/LDAP ×1.3</option></select></Field>
              <Field label="Standar compliance"><select value={a.compliance} onChange={(e) => upd({ compliance: e.target.value })}><option value="owasp">OWASP ×1.0</option><option value="owasp_formal">OWASP formal ×1.1</option><option value="ojk">SEOJK/OJK ×1.2</option><option value="pci">PCI-DSS ×1.3</option></select></Field>
            </div>
          </details>
          <details><summary>Mobile application ({a.mobile.length})</summary>
            {listEditor('mobile', { name: '', platform: 'dual', feature: 'basic', includeBackend: false }, (r, _i, set) => (
              <div className="grid g2">
                <Field label="Nama"><input value={r.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="Platform"><select value={r.platform} onChange={(e) => set({ platform: e.target.value })}><option value="android">Android</option><option value="ios">iOS</option><option value="dual">Android + iOS</option></select></Field>
                <Field label="Fitur"><select value={r.feature} onChange={(e) => set({ feature: e.target.value })}><option value="basic">Basic</option><option value="fintech">Payment/Fintech</option><option value="biometric">Biometric/Crypto/NFC</option><option value="offline_pki">Offline/PKI</option></select></Field>
                <label className="check"><input type="checkbox" checked={r.includeBackend} onChange={(e) => set({ includeBackend: e.target.checked })} /> Termasuk backend API</label>
              </div>))}
          </details>
          <details><summary>API / web service ({a.api.length})</summary>
            {listEditor('api', { name: '', endpoints: 25, auth: 'basic', doc: 'documented' }, (r, _i, set) => (
              <div className="grid g2">
                <Field label="Nama service"><input value={r.name} onChange={(e) => set({ name: e.target.value })} /></Field>
                <Field label="Jumlah endpoint"><input type="number" min={1} inputMode="numeric" value={r.endpoints} onChange={(e) => set({ endpoints: n(e.target.value) })} /></Field>
                <Field label="Dokumentasi"><select value={r.doc} onChange={(e) => set({ doc: e.target.value })}><option value="documented">Swagger/Postman</option><option value="limited">Terbatas</option><option value="none">Tidak ada</option></select></Field>
              </div>))}
          </details>
          <details><summary>Network & infrastruktur</summary>
            <div className="grid g3">
              {[['externalIps', 'IP publik'], ['internalHosts', 'Host internal'], ['wifiClusters', 'Cluster Wi-Fi'], ['firewallPolicies', 'Firewall policy review'], ['cloudAccounts', 'Cloud account']].map(([k, l]) => (
                <Field key={k} label={l}><input type="number" min={0} inputMode="numeric" value={a.network[k]} onChange={(e) => upd({ network: { ...a.network, [k]: n(e.target.value) } })} /></Field>))}
              <label className="check"><input type="checkbox" checked={a.network.activeDirectory} onChange={(e) => upd({ network: { ...a.network, activeDirectory: e.target.checked } })} /> Active Directory</label>
            </div>
          </details>
          <div className="grid g3" style={{ marginTop: 8 }}>
            <Field label="Lokasi kerja"><select value={a.workLocation} onChange={(e) => upd({ workLocation: e.target.value })}><option>remote</option><option>onsite</option><option>hybrid</option></select></Field>
            <Field label="Window pengujian"><input value={a.assessmentWindow} placeholder="mis. Senin–Jumat 20:00–04:00" onChange={(e) => upd({ assessmentWindow: e.target.value })} /></Field>
            <Field label="Standar laporan"><input value={a.reportingStandard} onChange={(e) => upd({ reportingStandard: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={a.includeJunior} onChange={(e) => upd({ includeJunior: e.target.checked })} /> Libatkan Junior pentester</label>
        </>
      ) : type === 'CTI' ? (
        <div className="grid g3" style={{ marginTop: 8 }}>
          {[['domains', 'Jumlah domain dipantau'], ['subsidiaries', 'Jumlah anak usaha/brand'], ['publicIps', 'Jumlah IP publik'], ['rfiPerMonth', 'RFI per bulan'], ['takedownsPerYear', 'Takedown per tahun (di luar paket)'], ['contractMonths', 'Durasi kontrak (bulan)']].map(([k, l]) =>
            <Field key={k} label={l}><input type="number" min={0} inputMode="numeric" value={a[k]} onChange={(e) => upd({ [k]: n(e.target.value) })} /></Field>)}
          <Field label="Titik harga dalam range tier"><select value={a.pricePoint} onChange={(e) => upd({ pricePoint: e.target.value })}><option value="low">Bawah</option><option value="mid">Tengah</option><option value="high">Atas</option></select></Field>
          <label className="check"><input type="checkbox" checked={a.darkWebMonitoring} onChange={(e) => upd({ darkWebMonitoring: e.target.checked })} /> Dark web monitoring</label>
          <label className="check"><input type="checkbox" checked={a.siemIntegration} onChange={(e) => upd({ siemIntegration: e.target.checked })} /> Integrasi SIEM</label>
          <label className="check"><input type="checkbox" checked={a.apiIntegration} onChange={(e) => upd({ apiIntegration: e.target.checked })} /> Integrasi API feed lain</label>
        </div>
      ) : type === 'GRC' ? (
        <>
          <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={!!a.iso} onChange={(e) => upd({ iso: e.target.checked ? emptyGrc.iso : undefined })} /> ISO implementation</label>
          {a.iso && <div className="grid g3" style={{ marginTop: 6 }}>
            <Field label="Framework"><select multiple style={{ minHeight: 100 }} value={a.iso.frameworks} onChange={(e) => upd({ iso: { ...a.iso, frameworks: Array.from(e.target.selectedOptions).map((o) => o.value) } })}>
              {[['iso27001', 'ISO/IEC 27001'], ['iso27701', 'ISO/IEC 27701'], ['iso9001', 'ISO 9001'], ['iso20000', 'ISO/IEC 20000-1'], ['iso22301', 'ISO 22301']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Jumlah karyawan"><input type="number" min={1} value={a.iso.employees} onChange={(e) => upd({ iso: { ...a.iso, employees: n(e.target.value) } })} /></Field>
            <Field label="Jumlah lokasi dalam scope"><input type="number" min={1} value={a.iso.locations} onChange={(e) => upd({ iso: { ...a.iso, locations: n(e.target.value) } })} /></Field>
            <Field label="Scope"><select value={a.iso.scope} onChange={(e) => upd({ iso: { ...a.iso, scope: e.target.value } })}><option value="department">1 departemen</option><option value="it_security">IT + Security</option><option value="company">Seluruh perusahaan</option><option value="group">Multi-entitas/grup</option></select></Field>
            <Field label="Maturity saat ini"><select value={a.iso.maturity} onChange={(e) => upd({ iso: { ...a.iso, maturity: e.target.value } })}><option value="1">1 — Ad hoc</option><option value="2">2 — Kebijakan ada, tidak dijalankan</option><option value="3">3 — Terdefinisi & dijalankan</option><option value="4">4 — Terukur</option></select></Field>
            <Field label="Tipe layanan"><select value={a.iso.serviceType} onChange={(e) => upd({ iso: { ...a.iso, serviceType: e.target.value } })}><option value="gap">GAP assessment</option><option value="full">Full implementation</option><option value="full_audit">Implementasi + pendampingan audit</option></select></Field>
            <label className="check"><input type="checkbox" checked={a.iso.existingIsms} onChange={(e) => upd({ iso: { ...a.iso, existingIsms: e.target.checked } })} /> Sudah ada ISMS</label>
          </div>}
          <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={!!a.pdp} onChange={(e) => upd({ pdp: e.target.checked ? { dpoHours: 'lt8', dpiaCount: 0, months: 12 } : undefined })} /> PDP / DPO as a Service</label>
          {a.pdp && <div className="grid g3" style={{ marginTop: 6 }}>
            <Field label="Jam DPO per bulan"><select value={a.pdp.dpoHours ?? ''} onChange={(e) => upd({ pdp: { ...a.pdp, dpoHours: e.target.value || undefined } })}><option value="">Tidak perlu DPO</option><option value="lt8">&lt; 8 jam</option><option value="h8_20">8–20 jam</option><option value="h20_40">20–40 jam</option><option value="gt40">&gt; 40 jam (custom)</option></select></Field>
            <Field label="Jumlah DPIA"><input type="number" min={0} value={a.pdp.dpiaCount} onChange={(e) => upd({ pdp: { ...a.pdp, dpiaCount: n(e.target.value) } })} /></Field>
            <Field label="Durasi (bulan)"><input type="number" min={1} value={a.pdp.months} onChange={(e) => upd({ pdp: { ...a.pdp, months: n(e.target.value) } })} /></Field>
          </div>}
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 10 }}>Inventaris aset (untuk EPS)</h3>
          <div className="grid g3">
            {SOC_ASSETS.map(([k, l]) => <Field key={k} label={l}><input type="number" min={0} inputMode="numeric" value={a.assets[k] ?? 0} onChange={(e) => upd({ assets: { ...a.assets, [k]: n(e.target.value) } })} /></Field>)}
          </div>
          <div className="grid g3">
            <Field label="Metode EPS"><select value={a.method} onChange={(e) => upd({ method: e.target.value })}><option value="simplified">Simplified (disarankan)</option><option value="per_device">Per device</option></select></Field>
            <Field label="Jumlah log source"><input type="number" min={0} value={a.logSources} onChange={(e) => upd({ logSources: n(e.target.value) })} /></Field>
            <Field label="Jam layanan"><select value={a.coverage} onChange={(e) => upd({ coverage: e.target.value })}><option>8x5</option><option>16x7</option><option>24x7</option></select></Field>
            <Field label="Tier layanan"><select value={a.serviceTier} onChange={(e) => upd({ serviceTier: e.target.value })}><option value="essential">Essential</option><option value="standard">Standard</option><option value="advanced">Advanced</option></select></Field>
            <Field label="Endpoint Managed EDR"><input type="number" min={0} value={a.edrEndpoints} onChange={(e) => upd({ edrEndpoints: n(e.target.value) })} /></Field>
            <Field label="Durasi kontrak (bulan)"><input type="number" min={1} max={60} value={a.contractMonths} onChange={(e) => upd({ contractMonths: n(e.target.value) })} /></Field>
            <Field label="Platform SIEM"><input value={a.siemPlatform} placeholder="mis. FortiSIEM / QRadar" onChange={(e) => upd({ siemPlatform: e.target.value })} /></Field>
            <Field label="Retensi log (hari)"><input type="number" min={1} value={a.retentionDays} onChange={(e) => upd({ retentionDays: n(e.target.value) })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={a.includeOnboarding} onChange={(e) => upd({ includeOnboarding: e.target.checked })} /> Termasuk biaya onboarding</label>
        </>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={act.busy} onClick={saveAndCalc}>{rec ? 'Simpan & hitung ulang' : 'Simpan & hitung effort'}</button>
        {rec?.status === 'ENGINEER_REVIEW_REQUIRED' && me?.permissions.includes('assessment.review') && <button type="button" className="btn ok" disabled={act.busy} onClick={review}>Sahkan (engineer review)</button>}
        {saved && <span className="sub">Draft tersimpan {saved}</span>}
      </div>
      {rec?.result && <SizingResult r={rec.result} />}
    </div>
  );
}

export function SizingResult({ r }: { r: any }) {
  return (
    <div style={{ marginTop: 12 }}>
      {r.flags?.map((f: string) => <div key={f} className="alert warn">{f}</div>)}
      {r.service === 'CTI' ? (
        <>
          <p>Skor risiko industri {r.industryRisk} + footprint {r.footprintScore} = <b>{r.totalScore}</b> → <b>{r.tier?.label}</b></p>
          <div className="table-wrap"><table className="t"><tbody>{r.lines.map((l: any) => <tr key={l.item}><td>{l.item}</td><td className="r">{l.qty} {l.unit}</td><td className="r">Rp {Number(l.unitPrice).toLocaleString('id-ID')}</td></tr>)}</tbody></table></div>
          <p style={{ marginTop: 8 }}>MRC Rp {Number(r.monthlyTotal).toLocaleString('id-ID')} · <b>Nilai kontrak referensi Rp {Number(r.contractValue).toLocaleString('id-ID')}</b></p>
        </>
      ) : r.service === 'GRC' ? (
        <>
          {r.lines.map((l: any) => <div key={l.item}><b>{l.item}</b> — {l.md} MD<div className="mono">{l.formula}</div></div>)}
          {r.totalMd > 0 && <p style={{ marginTop: 8 }}>Tim: PM {r.team.pm} · Lead {r.team.lead} · Senior {r.team.senior} · Junior {r.team.junior} → <b>Total {r.totalMd} MD</b></p>}
          {r.pdpLines?.map((l: any) => <div key={l.item}>{l.item}: {l.qty} {l.unit} × Rp {Number(l.unitPrice).toLocaleString('id-ID')}</div>)}
          {r.pdpValue > 0 && <p><b>Nilai PDP Rp {Number(r.pdpValue).toLocaleString('id-ID')}</b></p>}
        </>
      ) : r.service === 'VAPT' ? (
        <>
          <div className="table-wrap"><table className="t"><thead><tr><th>Item</th><th>Formula</th><th className="r">MD</th></tr></thead><tbody>
            {r.lines.map((l: any) => <tr key={l.item}><td>{l.item}</td><td className="mono">{l.formula}</td><td className="r">{l.md}</td></tr>)}
            <tr><td colSpan={2}><b>MD teknis</b></td><td className="r"><b>{r.technicalMd}</b></td></tr>
          </tbody></table></div>
          <p style={{ marginTop: 8 }}>Tim: PM {r.team.pm} · Lead {r.team.lead} · Senior {r.team.senior} · Junior {r.team.junior} → <b>Total {r.totalMd} MD</b></p>
        </>
      ) : (
        <>
          <p>Total EPS {r.totalEps} → efektif (×1.2 burst) <b>{r.effectiveEps} EPS</b>{r.band ? ` · band ≤${r.band.maxEps} (${r.band.team})` : ' · CUSTOM'}</p>
          <div className="table-wrap"><table className="t"><thead><tr><th>Komponen</th><th className="r">Qty</th><th className="r">Harga</th></tr></thead><tbody>
            {r.lines.map((l: any) => <tr key={l.item}><td>{l.item}</td><td className="r">{l.qty} {l.unit}</td><td className="r">Rp {Number(l.unitPrice).toLocaleString('id-ID')}</td></tr>)}
          </tbody></table></div>
          <p style={{ marginTop: 8 }}>MRC Rp {Number(r.monthlyTotal).toLocaleString('id-ID')} · OTC Rp {Number(r.oneTimeTotal).toLocaleString('id-ID')} · <b>Nilai kontrak referensi Rp {Number(r.contractValue).toLocaleString('id-ID')}</b></p>
        </>
      )}
      {r.engineerAdjustment && <div className="alert info">Disesuaikan engineer: {r.engineerAdjustment.by}</div>}
      <div className="sub">Kebijakan: {r.policy?.code} v{r.policy?.version}</div>
    </div>
  );
}
