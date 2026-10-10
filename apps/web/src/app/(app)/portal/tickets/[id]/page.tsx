'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi } from '@/components/ui';

export default function PortalTicket() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useApi(`/api/v1/portal/tickets/${id}`);
  const act = useAction();
  const [body, setBody] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const t = data.ticket;
  return (
    <>
      <PageHead title={t.number} crumbs={<Link href="/portal/tickets">Bantuan</Link>} sub={t.title} actions={<><Badge s={t.priority} /><Badge s={t.status} /></>} />
      <ErrorBox error={act.error} />
      <div className="card">
        <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>
        <div className="sub">Dibuat {dt(t.createdAt)} · target respons {dt(t.responseDueAt)}{t.firstResponseAt ? ` (direspons ${dt(t.firstResponseAt)})` : ''} · target selesai {dt(t.resolutionDueAt)}</div>
        {t.status === 'RESOLVED' && (
          <div className="row" style={{ marginTop: 8 }}>
            <span className="sub">Tim kami menandai tiket ini selesai.</span>
            <button className="btn ok sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/api/v1/portal/tickets/${id}/confirm`, { body: {} }); reload(); })}>Konfirmasi selesai</button>
            <button className="btn sec sm" disabled={act.busy} onClick={() => act.run(async () => { await api(`/api/v1/portal/tickets/${id}/reopen`, { body: {} }); reload(); })}>Belum selesai</button>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Percakapan</h2>
        {data.comments.map((c: any) => (
          <div key={c.id} className="list-item"><div className="row"><b>{c.fromCustomer ? 'Anda' : `DefendIT360 — ${c.authorName ?? ''}`}</b><span className="spacer" /><span className="sub">{dt(c.createdAt)}</span></div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></div>
        ))}
        {!data.comments.length && <div className="empty">Belum ada balasan</div>}
        {t.status !== 'CLOSED' && (
          <div style={{ marginTop: 8 }}>
            <Field label="Tambahkan informasi"><textarea value={body} onChange={(e) => setBody(e.target.value)} /></Field>
            <button className="btn" disabled={act.busy || body.length < 2} onClick={() => act.run(async () => { await api(`/api/v1/portal/tickets/${id}/comments`, { body: { body } }); setBody(''); reload(); })}>Kirim</button>
          </div>
        )}
      </div>
    </>
  );
}
