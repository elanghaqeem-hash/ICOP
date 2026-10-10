'use client';
import Link from 'next/link';
import { idr, jt } from '@/lib/api';
import { ErrorBox, Loading, PageHead, useApi, useMe } from '@/components/ui';

const fmt = (k: { value: number | null; unit: string }) =>
  k.value === null ? '—' : k.unit === 'IDR' ? jt(k.value) : k.unit === '%' ? `${k.value}%` : k.unit === 'jam' ? `${k.value} jam` : k.unit === 'hari' ? `${k.value} hari` : String(k.value);

export default function Dashboard() {
  const me = useMe();
  const { data, error, loading } = useApi(me?.permissions.includes('dashboard.read') ? '/api/v1/dashboard' : null);
  const notes = useApi('/api/v1/notifications');
  return (
    <>
      <PageHead title={`Halo, ${me?.fullName ?? ''}`} sub="Ringkasan bisnis dari transaksi riil" />
      <div className="row" style={{ marginBottom: 12 }}>
        <Link className="btn sec sm" href="/quotations">Quotation</Link>
        <Link className="btn sec sm" href="/customers">Customer</Link>
        {me?.permissions.includes('tender.read') && <Link className="btn sec sm" href="/tenders?due=7">Tender ≤ 7 hari</Link>}
        {me?.permissions.includes('vendor.read') && <Link className="btn sec sm" href="/vendors">Vendor</Link>}
        {me?.permissions.includes('policy.read') && <Link className="btn sec sm" href="/settings">Kebijakan & AI</Link>}
        {me?.permissions.includes('audit.read') && <Link className="btn sec sm" href="/audit">Audit</Link>}
      </div>
      <ErrorBox error={error} />
      {loading && me?.permissions.includes('dashboard.read') ? <Loading /> : data && (
        <>
          <div className="grid g4">
            {data.kpis.map((k: any) => (
              <Link key={k.key} href={k.drill} className="card kpi" title={k.definition} style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="l">{k.label}</div>
                <div className="v">{fmt(k)}{k.secondary ? <span className="badge bad" style={{ marginLeft: 6 }}>{k.secondary} overdue</span> : null}</div>
                <div className="sub" style={{ fontSize: '.72rem' }}>{k.definition}</div>
              </Link>
            ))}
          </div>
          <div className="grid g2">
            <div className="card">
              <h3>Pipeline per stage</h3>
              <table className="t"><tbody>
                {['LEAD', 'QUALIFIED', 'SCOPING', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'].map((s) => {
                  const r = data.byStage.find((x: any) => x.stage === s);
                  return <tr key={s}><td><Link href={`/pipeline?stage=${s}`}>{s}</Link></td><td className="r">{r?.n ?? 0}</td><td className="r">{idr(r?.value ?? 0)}</td></tr>;
                })}
              </tbody></table>
            </div>
            <div className="card">
              <h3>Pipeline per layanan</h3>
              {data.byService.length === 0 ? <div className="empty">Belum ada opportunity</div> : (
                <table className="t"><tbody>
                  {data.byService.map((r: any) => <tr key={r.serviceCategory}><td>{r.serviceCategory.replace(/_/g, ' ')}</td><td className="r">{r.n}</td><td className="r">{idr(r.value)}</td></tr>)}
                </tbody></table>
              )}
            </div>
          </div>
        </>
      )}
      <div className="card">
        <h3>Notifikasi</h3>
        {notes.data?.items?.length ? notes.data.items.slice(0, 8).map((n: any) => (
          <Link key={n.id} href={n.link ?? '#'} className="list-item"><b>{n.title}</b><div className="sub">{n.body}</div></Link>
        )) : <div className="empty">Tidak ada notifikasi</div>}
      </div>
    </>
  );
}
