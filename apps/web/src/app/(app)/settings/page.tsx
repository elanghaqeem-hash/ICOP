'use client';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
import CompanyFacts from '@/components/CompanyFacts';
import AiSettings from '@/components/AiSettings';
import SmtpSettings from '@/components/SmtpSettings';
import IntegrationsSettings from '@/components/IntegrationsSettings';

export default function Settings() {
  const me = useMe();
  const pol = useApi('/api/v1/policies');
  const act = useAction();
  const [tab, setTab] = useState<'ai' | 'smtp' | 'integrations' | 'policy' | 'facts'>('ai');
  const activate = (id: string) => act.run(async () => { await api(`/api/v1/policies/${id}/activate`, { body: {} }); pol.reload(); });
  return (
    <>
      <PageHead title="Kebijakan & AI" sub="Kebijakan berversi; aktivasi oleh Direktur (maker-checker)" />
      <ErrorBox error={act.error} />
      <div className="row" style={{ marginBottom: 10 }} role="tablist">
        <button className={`btn sm ${tab === 'ai' ? '' : 'sec'}`} onClick={() => setTab('ai')}>AI & API key</button>
        {me?.permissions.includes('integration.admin') && <button className={`btn sm ${tab === 'smtp' ? '' : 'sec'}`} onClick={() => setTab('smtp')}>Email (SMTP)</button>}
        {me?.permissions.includes('integration.admin') && <button className={`btn sm ${tab === 'integrations' ? '' : 'sec'}`} onClick={() => setTab('integrations')}>Integrasi</button>}
        <button className={`btn sm ${tab === 'policy' ? '' : 'sec'}`} onClick={() => setTab('policy')}>Kebijakan</button>
        <button className={`btn sm ${tab === 'facts' ? '' : 'sec'}`} onClick={() => setTab('facts')}>Company facts & job</button>
      </div>
      {tab === 'ai' && <AiSettings />}
      {tab === 'smtp' && <SmtpSettings />}
      {tab === 'integrations' && <IntegrationsSettings />}
      {tab === 'policy' && <div className="card">
        <h2>Kebijakan pricing & DoA</h2>
        {pol.loading ? <Loading /> : <div className="table-wrap"><table className="t"><thead><tr><th>Kode</th><th>Jenis</th><th>Judul</th><th>Status</th><th>Berlaku</th><th></th></tr></thead><tbody>
          {pol.data?.items.map((p: any) => (
            <tr key={p.id}><td className="mono">{p.code} v{p.version}</td><td>{p.kind}</td><td>{p.title}<div className="sub">{p.sourceNote}</div></td>
              <td><Badge s={p.status} />{p.isCurrent && <> <span className="badge ok">current</span></>}{p.approvedByName && <div className="sub">oleh {p.approvedByName} {dt(p.approvedAt)}</div>}</td>
              <td>{p.effectiveFrom?.slice?.(0, 10) ?? p.effectiveFrom}</td>
              <td>{me?.permissions.includes('policy.activate') && p.status !== 'ACTIVE' && p.status !== 'RETIRED' && <button className="btn ok sm" onClick={() => activate(p.id)}>Sahkan & aktifkan</button>}</td></tr>
          ))}</tbody></table></div>}
      </div>}
      {tab === 'facts' && <CompanyFacts />}
      {tab === 'facts' && me?.permissions.includes('jobs.run') && <div className="card"><h2>Job terjadwal</h2><p className="sub">Eskalasi approval, pengingat tender, kedaluwarsa wallet, status e-sign VIDA, feed tender, pelanggaran SLA helpdesk, renewal H-180/90/60/30, dan penagihan jatuh tempo berjalan otomatis tiap 15 menit; jalankan manual bila perlu.</p>
        <button className="btn sec sm" disabled={act.busy} onClick={() => act.run(async () => { const r = await api('/api/v1/admin/jobs/run', { body: {} }); window.alert(Object.entries(r).map(([k, v]) => `${k}: ${Object.entries(v as Record<string, unknown>).map(([a, b]) => `${a}=${b}`).join(', ')}`).join('\n')); })}>Jalankan sekarang</button></div>}
    </>
  );
}
