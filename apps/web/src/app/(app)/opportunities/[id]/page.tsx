'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, dt, idr, newKey } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';
import ScopingForm, { SizingResult } from '@/components/ScopingForm';
import PricingPanel from '@/components/PricingPanel';
import AiBox from '@/components/AiBox';

const NEXT: Record<string, string[]> = {
  LEAD: ['QUALIFIED', 'LOST'], QUALIFIED: ['SCOPING', 'LOST'], SCOPING: ['PROPOSAL', 'LOST'], PROPOSAL: ['NEGOTIATION', 'WON', 'LOST'],
  NEGOTIATION: ['WON', 'PROPOSAL', 'LOST'], WON: [], LOST: ['LEAD'],
};

export default function Deal360() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const me = useMe();
  const { data, error, loading, reload } = useApi(`/api/v1/opportunities/${id}`);
  const [tab, setTab] = useState('overview');
  const [newScoping, setNewScoping] = useState(false);
  const act = useAction();
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const o = data.opportunity;
  const perms = me?.permissions ?? [];
  const move = (stage: string) => act.run(async () => {
    let lostReason: string | undefined;
    if (stage === 'LOST') { lostReason = window.prompt('Alasan kalah (wajib):') ?? undefined; if (!lostReason) return; }
    await api(`/api/v1/opportunities/${id}/stage`, { body: { stage, lostReason } });
    reload();
  });
  const tabs = [['overview', 'Ringkasan'], ['scoping', `Scoping (${data.assessments.length})`],
    ...(perms.includes('pricing.calculate') ? [['pricing', 'Pricing']] : []), ['quotations', `Quotation (${data.quotations.length})`], ...(perms.includes('proposal.read') ? [['proposals', 'Proposal']] : []), ['ai', 'AI']];

  return (
    <>
      <PageHead crumbs={<><Link href="/pipeline">Pipeline</Link> / <Link href={`/customers/${o.customerId}`}>{o.customerName}</Link></>}
        title={o.name} sub={<>{o.code} · {o.serviceCategory} · Tier {o.clientTier} · {idr(o.amountEstimate)} · {o.probability}% · owner {o.ownerName ?? '—'}</>}
        actions={<Badge s={o.stage} />} />
      <ErrorBox error={act.error} />
      {perms.includes('opportunity.write') && NEXT[o.stage].length > 0 && (
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="sub">Pindah ke:</span>
          {NEXT[o.stage].map((s) => <button key={s} className={`btn sm ${s === 'LOST' ? 'bad' : s === 'WON' ? 'ok' : 'sec'}`} disabled={act.busy} onClick={() => move(s)}>{s}</button>)}
        </div>
      )}
      <div className="tabs">{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'overview' && (
        <div className="grid g2">
          <div className="card">
            <h3>Detail</h3>
            <dl className="kv">
              <dt>Sumber</dt><dd>{o.source}{o.isTender ? ' · tender' : ''}</dd>
              <dt>Target closing</dt><dd>{o.expectedClose ?? '—'}</dd>
              <dt>Kompetitor</dt><dd>{o.competitors?.join(', ') || '—'}</dd>
              <dt>Next action</dt><dd>{o.nextAction ?? '—'}</dd>
              {o.lostReason && <><dt>Alasan kalah</dt><dd>{o.lostReason}</dd></>}
            </dl>
          </div>
          <div className="card">
            <h3>Riwayat stage</h3>
            {data.stageHistory.map((h: any) => <div key={h.id} className="step"><Badge s={h.toStage} /><span className="sub">{dt(h.changedAt)} · {h.changedByName}</span></div>)}
          </div>
          <div className="card">
            <h3>Approval terkait</h3>
            {data.approvals.length ? data.approvals.map((a: any) => <Link key={a.id} href={`/approvals/${a.id}`} className="list-item"><Badge s={a.status} /> Level {a.requiredLevel} · {dt(a.createdAt)}</Link>) : <div className="empty">Belum ada</div>}
          </div>
          <div className="card">
            <h3>Aktivitas</h3>
            {data.activities.length ? data.activities.map((a: any) => <div key={a.id} className="step"><b>{a.kind}</b> {a.subject}<span className="sub">{dt(a.createdAt)}</span></div>) : <div className="empty">Catat dari halaman customer</div>}
          </div>
        </div>
      )}

      {tab === 'scoping' && (
        <>
          {data.assessments.map((a: any) => (
            a.status === 'REVIEWED' || !perms.includes('assessment.write')
              ? <div key={a.id} className="card"><div className="row"><b>{a.serviceType}</b><Badge s={a.status} /><span className="badge">Kelengkapan {a.completeness}%</span></div>{a.result && <SizingResult r={a.result} />}</div>
              : <AssessmentLoader key={a.id} id={a.id} customerId={o.customerId} opportunityId={id} onDone={reload} />
          ))}
          {perms.includes('assessment.write') && (newScoping
            ? <ScopingForm customerId={o.customerId} opportunityId={id} onDone={() => { setNewScoping(false); reload(); }} />
            : <button className="btn pur" onClick={() => setNewScoping(true)}>+ Assessment baru</button>)}
        </>
      )}

      {tab === 'pricing' && <PricingPanel opp={o} assessments={data.assessments} scenarios={data.scenarios} onDone={(qid) => (qid ? router.push(`/quotations/${qid}`) : reload())} />}

      {tab === 'quotations' && (
        <div className="card" style={{ padding: 0 }}>
          {data.quotations.length ? data.quotations.map((q: any) => (
            <Link key={q.id} href={`/quotations/${q.id}`} className="list-item"><div className="row"><b className="mono">{q.number}{q.revision ? ` Rev.${q.revision}` : ''}</b><span className="spacer" /><Badge s={q.status} /></div>
              <div className="sub">{q.title} · {idr(q.grandTotal)}{q.grossMarginPct != null ? ` · margin ${q.grossMarginPct}%` : ''}</div></Link>
          )) : <div className="empty">Buat quotation dari scenario di tab Pricing</div>}
        </div>
      )}

      {tab === 'proposals' && <ProposalList oppId={id} canWrite={perms.includes('proposal.write')} />}
      {tab === 'ai' && <AiBox opportunityId={id} />}
    </>
  );
}

function AssessmentLoader({ id, customerId, opportunityId, onDone }: { id: string; customerId: string; opportunityId: string; onDone: () => void }) {
  const { data } = useApi(`/api/v1/assessments/${id}`);
  if (!data) return <Loading />;
  return <ScopingForm customerId={customerId} opportunityId={opportunityId} existing={data} onDone={onDone} />;
}

function ProposalList({ oppId, canWrite }: { oppId: string; canWrite: boolean }) {
  const router = useRouter();
  const { data } = useApi(`/api/v1/proposals?opportunityId=${oppId}`);
  const act = useAction();
  const [lang, setLang] = useState('id');
  return (
    <div className="card" style={{ padding: 0 }}>
      <ErrorBox error={act.error} />
      {data?.items.map((p: any) => (
        <Link key={p.id} href={`/proposals/${p.id}`} className="list-item"><div className="row"><b className="mono">{p.number}</b><span className="spacer" /><Badge s={p.status} /></div>
          <div className="sub">{p.title} · v{p.version}{p.openItems ? ` · ${p.openItems} bagian perlu dilengkapi` : ''}</div></Link>))}
      {canWrite && <div className="row" style={{ padding: 12 }}>
        <select style={{ width: 160 }} value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Bahasa"><option value="id">Bahasa Indonesia</option><option value="en">English</option></select>
        <button className="btn pur" disabled={act.busy} onClick={() => act.run(async () => { const p = await api('/api/v1/proposals', { body: { opportunityId: oppId, language: lang }, idempotencyKey: newKey() }); router.push(`/proposals/${p.id}`); })}>+ Generate proposal teknis</button>
        <span className="sub">Disusun dari scoping yang direview, katalog, dan company facts terverifikasi.</span>
      </div>}
    </div>
  );
}
