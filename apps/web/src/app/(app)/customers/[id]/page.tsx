'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const SERVICES = ['SOC_MDR', 'VAPT', 'RED_TEAM', 'DFIR', 'CTI', 'GRC', 'ISO', 'IT_AUDIT', 'PDP', 'BCM', 'AWARENESS', 'SECURITY_ENGINEERING', 'IT_INFRA', 'MANAGED_IT', 'OTHER'];

export default function Customer360() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data, error, loading, reload } = useApi(`/api/v1/customers/${id}`);
  const [panel, setPanel] = useState<'' | 'opp' | 'contact' | 'activity'>('');
  const [opp, setOpp] = useState({ name: '', serviceCategory: 'VAPT', amountEstimate: 0, source: 'direct', expectedClose: '' });
  const [ct, setCt] = useState({ fullName: '', title: '', email: '', phone: '', contactRole: 'primary', isDecisionMaker: false });
  const [ac, setAc] = useState({ kind: 'meeting', subject: '', notes: '' });
  const act = useAction();
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const c = data.customer;
  const w = me?.permissions.includes('customer.write');
  const strip = (o: any) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
  return (
    <>
      <PageHead crumbs={<Link href="/customers">Customer</Link>} title={c.legalName} sub={`${c.code} · ${c.industry} · ${c.classification} · Tier ${c.clientTier} · AM ${c.accountOwner ?? '—'}`}
        actions={w && <div className="row">
          <button className="btn pur sm" onClick={() => setPanel(panel === 'opp' ? '' : 'opp')}>+ Opportunity</button>
          <button className="btn sec sm" onClick={() => setPanel(panel === 'contact' ? '' : 'contact')}>+ Kontak</button>
          <button className="btn sec sm" onClick={() => setPanel(panel === 'activity' ? '' : 'activity')}>+ Aktivitas</button></div>} />
      <ErrorBox error={act.error} />
      {panel === 'opp' && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api('/api/v1/opportunities', { body: strip({ ...opp, customerId: id, amountEstimate: Number(opp.amountEstimate) }) }); setPanel(''); reload(); }); }}>
          <h2>Opportunity baru</h2>
          <div className="grid g2">
            <Field label="Nama opportunity *"><input required minLength={3} value={opp.name} onChange={(e) => setOpp({ ...opp, name: e.target.value })} /></Field>
            <Field label="Layanan"><select value={opp.serviceCategory} onChange={(e) => setOpp({ ...opp, serviceCategory: e.target.value })}>{SERVICES.map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Estimasi nilai (Rp)"><input type="number" min={0} inputMode="numeric" value={opp.amountEstimate} onChange={(e) => setOpp({ ...opp, amountEstimate: Number(e.target.value) })} /></Field>
            <Field label="Sumber"><select value={opp.source} onChange={(e) => setOpp({ ...opp, source: e.target.value })}>{['direct', 'referral', 'partner', 'tender', 'inbound'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Target closing"><input type="date" value={opp.expectedClose} onChange={(e) => setOpp({ ...opp, expectedClose: e.target.value })} /></Field>
          </div>
          <button className="btn" disabled={act.busy}>Simpan</button>
        </form>
      )}
      {panel === 'contact' && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api(`/api/v1/customers/${id}/contacts`, { body: strip(ct) }); setPanel(''); reload(); }); }}>
          <h2>Kontak / PIC</h2>
          <div className="grid g2">
            <Field label="Nama *"><input required value={ct.fullName} onChange={(e) => setCt({ ...ct, fullName: e.target.value })} /></Field>
            <Field label="Jabatan"><input value={ct.title} onChange={(e) => setCt({ ...ct, title: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={ct.email} onChange={(e) => setCt({ ...ct, email: e.target.value })} /></Field>
            <Field label="Telepon"><input inputMode="tel" value={ct.phone} onChange={(e) => setCt({ ...ct, phone: e.target.value })} /></Field>
            <Field label="Peran"><select value={ct.contactRole} onChange={(e) => setCt({ ...ct, contactRole: e.target.value })}>{['primary', 'technical', 'procurement', 'finance', 'management', 'other'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <label className="check"><input type="checkbox" checked={ct.isDecisionMaker} onChange={(e) => setCt({ ...ct, isDecisionMaker: e.target.checked })} /> Decision maker</label>
          </div>
          <button className="btn" disabled={act.busy}>Simpan</button>
        </form>
      )}
      {panel === 'activity' && (
        <form className="card" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api(`/api/v1/customers/${id}/activities`, { body: { ...ac, done: true } }); setPanel(''); reload(); }); }}>
          <h2>Catat aktivitas</h2>
          <div className="grid g2">
            <Field label="Jenis"><select value={ac.kind} onChange={(e) => setAc({ ...ac, kind: e.target.value })}>{['call', 'meeting', 'visit', 'email', 'task', 'note'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Subjek *"><input required value={ac.subject} onChange={(e) => setAc({ ...ac, subject: e.target.value })} /></Field>
          </div>
          <Field label="Catatan / MoM"><textarea value={ac.notes} onChange={(e) => setAc({ ...ac, notes: e.target.value })} /></Field>
          <button className="btn" disabled={act.busy}>Simpan</button>
        </form>
      )}
      <div className="grid g4">
        <div className="card kpi"><div className="l">Pipeline terbuka</div><div className="v">{idr(data.summary.openPipeline)}</div></div>
        <div className="card kpi"><div className="l">Weighted</div><div className="v">{idr(data.summary.weightedPipeline)}</div></div>
        <div className="card kpi"><div className="l">Quotation diterima</div><div className="v">{idr(data.summary.acceptedValue)}</div></div>
        <div className="card kpi"><div className="l">Decision maker</div><div className="v">{data.summary.decisionMakers}</div></div>
      </div>
      <div className="grid g2">
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 12px 0' }}><h3>Opportunity</h3></div>
          {data.opportunities.length ? data.opportunities.map((o: any) => (
            <Link key={o.id} href={`/opportunities/${o.id}`} className="list-item"><div className="row"><b>{o.name}</b><span className="spacer" /><Badge s={o.stage} /></div>
              <div className="sub">{o.code} · {o.serviceCategory} · {idr(o.amountEstimate)} · {o.probability}%</div></Link>
          )) : <div className="empty">Belum ada opportunity</div>}
        </div>
        <div className="card" style={{ padding: 0 }}>
          <div style={{ padding: '12px 12px 0' }}><h3>Quotation</h3></div>
          {data.quotations.length ? data.quotations.map((q: any) => (
            <Link key={q.id} href={`/quotations/${q.id}`} className="list-item"><div className="row"><b className="mono">{q.number}</b><span className="spacer" /><Badge s={q.status} /></div>
              <div className="sub">{q.title} · {idr(q.grandTotal)}{q.grossMarginPct != null ? ` · margin ${q.grossMarginPct}%` : ''}</div></Link>
          )) : <div className="empty">Belum ada quotation</div>}
        </div>
        <div className="card">
          <h3>Kontak & stakeholder</h3>
          {data.contacts.length ? <div className="table-wrap"><table className="t"><tbody>{data.contacts.map((x: any) => (
            <tr key={x.id}><td><b>{x.fullName}</b>{x.isDecisionMaker && <> <Badge s="DM" label="Decision maker" /></>}<div className="sub">{x.title ?? ''}</div></td><td>{x.contactRole}</td><td className="sub">{x.email ?? ''}<br />{x.phone ?? ''}</td></tr>
          ))}</tbody></table></div> : <div className="empty">Belum ada kontak</div>}
        </div>
        <div className="card">
          <h3>Riwayat aktivitas</h3>
          {data.activities.length ? data.activities.map((a: any) => (
            <div key={a.id} style={{ padding: '6px 0', borderBottom: '1px solid #eef0f4' }}><b>{a.kind}</b> — {a.subject}<div className="sub">{dt(a.createdAt)} · {a.ownerName}</div>{a.notes && <div style={{ fontSize: '.86rem' }}>{a.notes}</div>}</div>
          )) : <div className="empty">Belum ada aktivitas</div>}
        </div>
      </div>
      <div className="alert info">Kontrak, project, tiket, invoice, dan health score ditambahkan pada Phase 3–4 dan akan muncul di Customer 360 ini.</div>
    </>
  );
}
