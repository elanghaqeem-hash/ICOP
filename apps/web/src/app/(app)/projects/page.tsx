'use client';
import Link from 'next/link';
import { idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

export default function Projects() {
  const { data, error, loading } = useApi('/api/v1/projects');
  return (
    <>
      <PageHead title="Proyek" sub="Dibuat otomatis saat kontrak aktif — handover pre-sales → delivery" />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((p: any) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="list-item">
            <div className="row"><b className="mono">{p.code}</b><span className="spacer" /><Badge s={p.status} /></div>
            <div className="sub">{p.name} · {p.customerName}</div>
            <div className="sub">Kontrak {p.contractNumber} · {idr(p.contractValue)} · PM {p.pmName ?? 'belum ditetapkan'}</div>
          </Link>
        )) : <div className="empty">Belum ada proyek</div>}
      </div>}
    </>
  );
}
