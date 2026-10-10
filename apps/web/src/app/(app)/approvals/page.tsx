'use client';
import Link from 'next/link';
import { useState } from 'react';
import { dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';
import Delegations from '@/components/Delegations';

export default function DecisionCenter() {
  const [scope, setScope] = useState<'mine:PENDING' | 'all:PENDING' | 'all:APPROVED' | 'all:REJECTED' | 'delegation'>('mine:PENDING');
  const [s, st] = scope.split(':');
  const { data, error, loading } = useApi(scope === 'delegation' ? null : `/api/v1/approvals?scope=${s}&status=${st}`, [scope]);
  return (
    <>
      <PageHead title="Decision Center" sub="Approval diverifikasi ulang di server: role, level DoA, maker-checker, dan versi dokumen" />
      <div className="tabs">{([['mine:PENDING', 'Menunggu saya'], ['all:PENDING', 'Semua pending'], ['all:APPROVED', 'Disetujui'], ['all:REJECTED', 'Ditolak'], ['delegation', 'Delegasi']] as const).map(([k, l]) =>
        <button key={k} className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>{l}</button>)}</div>
      <ErrorBox error={error} />
      {scope === 'delegation' ? <Delegations /> : loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((a: any) => (
          <Link key={a.id} href={`/approvals/${a.id}`} className="list-item">
            <div className="row"><b>{a.summary.title}</b><span className="spacer" />{a.overdue && a.status === 'PENDING' && <span className="badge bad">Lewat SLA</span>}<Badge s={a.status} /></div>
            <div className="sub">{a.entityType === 'bid_assessment' ? 'Bid/No-Bid · nilai ' : ''}{idr(a.summary.totalBeforeTax)}{a.entityType === 'bid_assessment' ? '' : ' ex-PPN'} · diskon {a.summary.discountPct}%{a.summary.grossMarginPct != null ? ` · margin ${a.summary.grossMarginPct}%` : ''} · step {a.currentLevelLabel ?? '—'} · oleh {a.requestedByName} · {dt(a.createdAt)}</div>
            <div className="row" style={{ marginTop: 4 }}>{a.reasons.map((r: any) => <span key={r.type} className="badge pur">{r.type.replace(/_/g, ' ')} → {r.label}</span>)}</div>
          </Link>)) : <div className="empty">Tidak ada approval</div>}
      </div>}
    </>
  );
}
