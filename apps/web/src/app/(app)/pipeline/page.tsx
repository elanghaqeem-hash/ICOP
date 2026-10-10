'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { jt } from '@/lib/api';
import { ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

function Pipeline() {
  const sp = useSearchParams();
  const [mine, setMine] = useState(false);
  const [stage, setStage] = useState(sp.get('stage') ?? 'LEAD');
  const { data, error, loading } = useApi(`/api/v1/opportunities${mine ? '?mine=true' : ''}`, [mine]);
  const card = (o: any) => (
    <Link key={o.id} href={`/opportunities/${o.id}`} className="kcard">
      <b>{o.name}</b>
      <div className="sub">{o.customerName}</div>
      <div className="row" style={{ marginTop: 4, fontSize: '.8rem' }}><span>{jt(o.amountEstimate)}</span><span className="sub">· {o.probability}%</span><span className="spacer" /><span className="sub">{o.daysInStage} hari</span></div>
    </Link>
  );
  return (
    <>
      <PageHead title="Sales pipeline" sub="Klik kartu untuk membuka Deal 360 workspace" actions={<label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Milik saya</label>} />
      <ErrorBox error={error} />
      {loading ? <Loading /> : data && (
        <>
          <div className="tabs" role="tablist" style={{ display: 'flex' }}>
            {data.stages.map((s: string) => <button key={s} className={stage === s ? 'on' : ''} onClick={() => setStage(s)}>{s} ({data.board[s].length})</button>)}
          </div>
          <div className="mobile-only" style={{ display: 'block' }}>
            <div className="kanban" style={{ gridAutoColumns: 'minmax(260px, 1fr)' }}>
              {data.stages.filter((s: string) => typeof window !== 'undefined' && window.innerWidth >= 900 ? true : s === stage).map((s: string) => (
                <div key={s} className="kcol"><h3 style={{ padding: '2px 4px' }}>{s} · {jt(data.board[s].reduce((a: number, o: any) => a + Number(o.amountEstimate), 0))}</h3>
                  {data.board[s].length ? data.board[s].map(card) : <div className="empty">Kosong</div>}</div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
export default function Page() { return <Suspense fallback={<Loading />}><Pipeline /></Suspense>; }
