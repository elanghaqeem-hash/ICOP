'use client';
import { idr } from '@/lib/api';
import { Badge, ErrorBox, Loading, PageHead, useApi } from '@/components/ui';

export default function PortalInvoices() {
  const { data, error, loading } = useApi('/api/v1/portal/invoices');
  return (
    <>
      <PageHead title="Tagihan Anda" sub="Invoice dari DefendIT360 dan status pembayarannya" />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card" style={{ padding: 0 }}>
        {data?.items.length ? data.items.map((i: any) => (
          <div key={i.id} className="list-item">
            <div className="row"><b className="mono">{i.number}</b><span className="spacer" /><Badge s={i.status} /></div>
            <div className="sub">{i.description}</div>
            <div className="sub">Total {idr(i.total)} · sisa {idr(i.outstanding)} · jatuh tempo {String(i.dueDate).slice(0, 10)}</div>
          </div>
        )) : <div className="empty">Belum ada tagihan</div>}
      </div>}
    </>
  );
}
