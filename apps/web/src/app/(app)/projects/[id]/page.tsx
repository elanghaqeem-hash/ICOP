'use client';
import Link from 'next/link';
import ProjectDelivery from '@/components/ProjectDelivery';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const canManage = !!me?.permissions.includes('project.manage');
  const { data, error, loading, reload } = useApi(`/api/v1/projects/${id}`);
  const users = useApi(canManage ? '/api/v1/users' : null);
  const act = useAction();
  const [pmId, setPmId] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const p = data.project;
  const items = (p.handover?.items ?? []) as any[];
  const done = items.filter((i) => i.done).length;
  const patch = (body: any) => act.run(async () => { await api(`/api/v1/projects/${id}`, { method: 'PATCH', body }); reload(); });
  const pms = (users.data?.items ?? []).filter((u: any) => u.role === 'project_manager');
  return (
    <>
      <PageHead title={p.code} crumbs={<Link href="/projects">Proyek</Link>} sub={<>{p.name} · {p.customerName}</>} actions={<Badge s={p.status} />} />
      <ErrorBox error={act.error} />
      <div className="card">
        <dl className="kv">
          <dt>Kontrak</dt><dd><Link href={`/contracts/${p.contractId}`}>{p.contractNumber}</Link> · {p.contractType}</dd>
          <dt>Nilai kontrak</dt><dd>{idr(p.contractValue)}</dd>
          {p.budgetCost !== undefined && <><dt>Budget biaya / MD</dt><dd>{idr(p.budgetCost)} · {p.budgetMd ?? '—'} MD</dd></>}
          <dt>Periode</dt><dd>{String(p.startDate).slice(0, 10)} s/d {String(p.endDate).slice(0, 10)}</dd>
          <dt>Project Manager</dt><dd>{p.pmName ?? '—'}</dd>
          {p.kickoffAt && <><dt>Kickoff</dt><dd>{dt(p.kickoffAt)}</dd></>}
        </dl>
        {canManage && p.status === 'HANDOVER' && (
          <div className="row" style={{ marginTop: 8 }}>
            <select value={pmId} onChange={(e) => setPmId(e.target.value)} aria-label="Pilih PM" style={{ maxWidth: 260 }}><option value="">{p.pmName ? 'Ganti PM…' : 'Tetapkan PM…'}</option>{pms.map((u: any) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
            <button className="btn sec sm" disabled={act.busy || !pmId} onClick={() => { patch({ pmId }); setPmId(''); }}>Simpan PM</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Checklist handover ({done}/{items.length})</h2>
        <div className="bar"><span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} /></div>
        {items.map((i) => (
          <label key={i.key} className="check" style={{ padding: '5px 0' }}>
            <input type="checkbox" disabled={!canManage || p.status !== 'HANDOVER' || act.busy} checked={i.done} onChange={(e) => patch({ handoverItem: { key: i.key, done: e.target.checked } })} />
            <span>{i.label}{i.doneBy ? <span className="sub"> · {i.doneBy}, {dt(i.doneAt)}</span> : null}</span>
          </label>
        ))}
        {canManage && p.status === 'HANDOVER' && (
          <button className="btn" style={{ marginTop: 8 }} disabled={act.busy || done < items.length || !p.pmId} onClick={() => act.run(async () => { await api(`/api/v1/projects/${id}/kickoff`, { body: {} }); reload(); })}>Kickoff proyek</button>
        )}
      </div>

      {p.status !== 'HANDOVER' && <ProjectDelivery projectId={id} status={p.status} onChanged={reload} />}

      <div className="card">
        <h2>Milestone & penagihan</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Milestone</th><th>Jatuh tempo</th><th className="r">Tagihan</th><th>Status</th></tr></thead>
          <tbody>{data.milestones.map((m: any) => <tr key={m.id}><td>{m.seq}</td><td>{m.name}{m.bastRef ? <div className="sub">BAST {m.bastRef}</div> : null}</td><td>{m.dueDate ? String(m.dueDate).slice(0, 10) : '—'}</td><td className="r">{m.billingAmount ? idr(m.billingAmount) : ''}{m.billingPct ? <div className="sub">{Number(m.billingPct)}%</div> : null}</td>
            <td><Badge s={m.status} />{canManage && m.status !== 'ACCEPTED' && <MilestoneAccept projectId={id} milestoneId={m.id} onDone={reload} />}{m.status === 'ACCEPTED' && (m.invoiceId ? <div className="sub" style={{ marginTop: 4 }}><Link href={`/billing/${m.invoiceId}`}>{m.invoiceNumber}</Link> <Badge s={m.invoiceStatus} /></div> : <MilestoneInvoice projectId={id} milestoneId={m.id} onDone={reload} />)}</td></tr>)}
            {!data.milestones.length && <tr><td colSpan={5} className="empty">Belum ada</td></tr>}</tbody></table></div>
      </div>
    </>
  );
}

function MilestoneAccept({ projectId, milestoneId, onDone }: { projectId: string; milestoneId: string; onDone: () => void }) {
  const act = useAction();
  const [ref, setRef] = useState('');
  return (
    <div style={{ marginTop: 4 }}>
      <input placeholder="No. BAST ditandatangani" value={ref} onChange={(e) => setRef(e.target.value)} aria-label="Nomor BAST" />
      <button className="btn ok sm" style={{ marginTop: 4 }} disabled={act.busy || ref.length < 3} onClick={() => act.run(async () => { await api(`/api/v1/projects/${projectId}/milestones/${milestoneId}/accept`, { body: { bastRef: ref } }); onDone(); })}>Terima BAST</button>
      <ErrorBox error={act.error} />
    </div>
  );
}

function MilestoneInvoice({ projectId, milestoneId, onDone }: { projectId: string; milestoneId: string; onDone: () => void }) {
  const act = useAction();
  const me = useMe();
  if (!me?.permissions.includes('billing.write')) return <div className="sub">Menunggu tagihan Finance</div>;
  return (
    <div style={{ marginTop: 4 }}>
      <button className="btn pur sm" disabled={act.busy} onClick={() => act.run(async () => { const inv = await api(`/api/v1/projects/${projectId}/milestones/${milestoneId}/invoice`, { body: { dueDays: 30 }, idempotencyKey: newKey() }); window.location.href = `/billing/${inv.id}`; onDone(); })}>Buat invoice</button>
      <ErrorBox error={act.error} />
    </div>
  );
}
