'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function ApprovalDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const { data, error, loading, reload } = useApi(`/api/v1/approvals/${id}`);
  const [comment, setComment] = useState('');
  const act = useAction();
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const r = data.request; const q = data.entity; const s = r.summary;
  const decide = (decision: string) => act.run(async () => { await api(`/api/v1/approvals/${id}/decide`, { body: { decision, comment: comment || undefined }, idempotencyKey: newKey() }); setComment(''); reload(); });
  const canDecide = r.status === 'PENDING' && r.requestedBy !== me?.id; // kewenangan (termasuk delegasi) diverifikasi server
  return (
    <>
      <PageHead crumbs={<Link href="/approvals">Decision Center</Link>} title={s.title} sub={`Diajukan ${r.requestedByName} · ${dt(r.createdAt)} · SLA ${dt(r.dueAt)}`} actions={<Badge s={r.status} />} />
      {s.policyStatus !== 'ACTIVE' && <div className="alert warn">Kebijakan {r.policyCode} v{r.policyVersion}: {r.policyStatus}</div>}
      {s.warnings?.map((w: string) => <div key={w} className="alert warn">{w}</div>)}
      <div className="grid g4">
        <div className="card kpi"><div className="l">Nilai ex-PPN</div><div className="v">{idr(s.totalBeforeTax)}</div></div>
        <div className="card kpi"><div className="l">Diskon</div><div className="v">{s.discountPct}%</div></div>
        {s.grossMarginPct !== undefined && <div className="card kpi"><div className="l">Gross margin</div><div className="v">{s.grossMarginPct ?? '—'}%</div></div>}
        {s.floorPrice !== undefined && <div className="card kpi"><div className="l">Floor / biaya</div><div className="v" style={{ fontSize: '.95rem' }}>{idr(s.floorPrice)}<br />{idr(s.internalCost)}</div></div>}
      </div>
      <div className="grid g2">
        <div className="card">
          <h3>Alasan approval (DoA)</h3>
          {r.reasons.map((x: any) => <div key={x.type} className="step"><span className="badge pur">{x.type.replace(/_/g, ' ')}</span> nilai {x.metric === 'grandTotalExTax' ? idr(x.value) : x.value} → {x.label}</div>)}
          <h3 style={{ marginTop: 12 }}>Rantai approval</h3>
          {data.steps.map((x: any) => <div key={x.id} className="step"><Badge s={x.status} /> {x.seq}. {x.levelLabel} {x.decidedByName ? `· ${x.decidedByName} · ${dt(x.decidedAt)}` : ''}</div>)}
          <h3 style={{ marginTop: 12 }}>Keputusan (immutable)</h3>
          {data.decisions.length ? data.decisions.map((d: any) => <div key={d.id} className="step"><b>{d.decision}</b> {d.decidedByName}<span className="sub">{dt(d.createdAt)}</span>{d.comment && <span>— {d.comment}</span>}</div>) : <div className="empty">Belum ada</div>}
        </div>
        {q?.kind === 'bid_assessment' && <div className="card">
          <h3>Bid / No-Bid</h3>
          <p><Link href={`/tenders/${q.tenderId}`}>{q.tenderCode}</Link> · {q.tenderTitle}</p>
          <p>Rekomendasi <Badge s={q.recommendation} /> skor <b>{q.weightedScore}</b> · HPS {idr(q.hpsValue)} · deadline {dt(q.submissionDeadline)}</p>
          {q.knockouts?.length ? <div className="alert bad">{q.knockouts.join('; ')}</div> : null}
          {q.conditions && <p className="sub">Syarat: {q.conditions}</p>}
          <div className="table-wrap"><table className="t"><tbody>{Object.entries(q.scores).map(([k, v]: any) => <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td className="r">{v.score}</td></tr>)}</tbody></table></div>
        </div>}
        {q && q.kind !== 'bid_assessment' && <div className="card">
          <h3>Dokumen</h3>
          <p><Link href={`/quotations/${q.id}`} className="mono">{q.number}{q.revision ? ` Rev.${q.revision}` : ''}</Link> · {q.customerName}</p>
          <div className="table-wrap"><table className="t"><tbody>
            {q.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="r">{idr(l.amount)}</td></tr>)}
            <tr><td><b>Total + PPN</b></td><td className="r"><b>{idr(q.grandTotal)}</b></td></tr></tbody></table></div>
          <p className="sub" style={{ marginTop: 6 }}>Termin: {q.paymentTerms}</p>
        </div>}
      </div>
      {canDecide && (
        <div className="card">
          <h2>Keputusan Anda</h2>
          <ErrorBox error={act.error} />
          <Field label="Catatan / alasan (wajib untuk tolak / minta revisi)"><textarea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
          <div className="row">
            <button className="btn ok" disabled={act.busy} onClick={() => decide('APPROVE')}>Setujui</button>
            <button className="btn sec" disabled={act.busy} onClick={() => decide('REQUEST_REVISION')}>Minta revisi</button>
            <button className="btn bad" disabled={act.busy} onClick={() => decide('REJECT')}>Tolak</button>
          </div>
        </div>
      )}
    </>
  );
}
