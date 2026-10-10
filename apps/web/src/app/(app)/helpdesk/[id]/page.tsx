'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function TicketDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const canWork = !!me?.permissions.includes('helpdesk.work');
  const { data, error, loading, reload } = useApi(`/api/v1/tickets/${id}`);
  const users = useApi(canWork ? '/api/v1/users' : null);
  const act = useAction();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [resolution, setResolution] = useState('');
  if (loading || !data) return <><ErrorBox error={error} /><Loading /></>;
  const t = data.ticket;
  const patch = (b: any) => act.run(async () => { await api(`/api/v1/tickets/${id}`, { method: 'PATCH', body: b }); setResolution(''); reload(); });
  const due = (iso: string, done: string | null, breached: boolean) => <>{dt(iso)} {done ? <span className="sub">(selesai {dt(done)})</span> : null} {breached ? <span className="badge bad">terlewati</span> : null}</>;
  return (
    <>
      <PageHead title={t.number} crumbs={<Link href="/helpdesk">Helpdesk</Link>} sub={<>{t.customerName}{t.projectCode ? ` · ${t.projectCode}` : ''}</>} actions={<><Badge s={t.priority} /><Badge s={t.status} /></>} />
      <ErrorBox error={act.error} />
      <div className="card">
        <h2>{t.title}</h2>
        <p style={{ whiteSpace: 'pre-wrap' }}>{t.description}</p>
        <dl className="kv">
          <dt>Kategori / sumber</dt><dd>{t.category} · {t.source}{t.externalRef ? ` · ref ${t.externalRef}` : ''}</dd>
          {t.meta?.asset && <><dt>Aset</dt><dd>{t.meta.asset}</dd></>}
          {t.meta?.cvss != null && <><dt>CVSS / CVE</dt><dd>{t.meta.cvss} {t.meta.cve ?? ''}</dd></>}
          <dt>Target respons</dt><dd>{due(t.responseDueAt, t.firstResponseAt, t.responseBreached)}</dd>
          <dt>Target resolusi</dt><dd>{due(t.resolutionDueAt, t.resolvedAt, t.resolutionBreached)}</dd>
          <dt>Penanggung jawab</dt><dd>{t.assigneeName ?? '—'}</dd>
        </dl>
        {canWork && t.status !== 'CLOSED' && (
          <div className="grid g2" style={{ marginTop: 8 }}>
            <Field label="Tugaskan ke"><select value={t.assigneeId ?? ''} onChange={(e) => patch({ assigneeId: e.target.value || null })}><option value="">—</option>
              {(users.data?.items ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.fullName} ({u.role})</option>)}</select></Field>
            <Field label="Prioritas (menghitung ulang target SLA)"><select value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{['P1', 'P2', 'P3', 'P4'].map((p) => <option key={p}>{p}</option>)}</select></Field>
          </div>
        )}
        {canWork && data.allowedTransitions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {data.allowedTransitions.includes('RESOLVED') && <Field label="Ringkasan penyelesaian (wajib untuk RESOLVED)"><textarea value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>}
            <div className="row">{data.allowedTransitions.map((s: string) => (
              <button key={s} className={`btn sm ${s === 'RESOLVED' ? 'ok' : 'sec'}`} disabled={act.busy || (s === 'RESOLVED' && resolution.length < 10)} onClick={() => patch({ status: s, resolution: s === 'RESOLVED' ? resolution : undefined })}>{s.replace('_', ' ')}</button>
            ))}</div>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Percakapan</h2>
        {data.comments.map((c: any) => (
          <div key={c.id} className="list-item" style={{ background: c.internal ? '#fff8e6' : undefined }}>
            <div className="row"><b>{c.authorName ?? 'Sistem'}</b>{c.internal && <span className="badge warn">internal</span>}<span className="spacer" /><span className="sub">{dt(c.createdAt)}</span></div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        ))}
        {!data.comments.length && <div className="empty">Belum ada</div>}
        {canWork && t.status !== 'CLOSED' && (
          <div style={{ marginTop: 8 }}>
            <Field label="Balas"><textarea value={body} onChange={(e) => setBody(e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Catatan internal (tidak terlihat customer, tidak dihitung sebagai respons)</label>
            <button className="btn" style={{ marginTop: 6 }} disabled={act.busy || body.length < 2} onClick={() => act.run(async () => { await api(`/api/v1/tickets/${id}/comments`, { body: { body, internal } }); setBody(''); reload(); })}>Kirim</button>
          </div>
        )}
      </div>
    </>
  );
}
