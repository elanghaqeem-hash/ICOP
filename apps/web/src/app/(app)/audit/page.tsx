'use client';
import { dt } from '@/lib/api';
import { ErrorBox, Loading, PageHead, useApi } from '@/components/ui';
export default function Audit() {
  const { data, error, loading } = useApi('/api/v1/audit');
  return (
    <>
      <PageHead title="Audit trail" sub="Append-only — tidak dapat diubah atau dihapus (dijaga trigger database)" />
      <ErrorBox error={error} />
      {loading ? <Loading /> : <div className="card table-wrap"><table className="t"><thead><tr><th>Waktu</th><th>Aktor</th><th>Aksi</th><th>Entitas</th><th>IP</th></tr></thead><tbody>
        {data?.items.map((a: any) => <tr key={a.id}><td>{dt(a.at)}</td><td>{a.actorName ?? '—'}</td><td className="mono">{a.action}</td><td className="mono">{a.entityType}<div className="sub">{a.entityId?.slice(0, 8)}</div></td><td className="sub">{a.ip}</td></tr>)}
      </tbody></table></div>}
    </>
  );
}
