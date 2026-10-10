'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, dt, idr } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, useAction, useApi, useMe } from './ui';

const today = () => new Date().toISOString().slice(0, 10);

/** Delivery proyek: metrik progres/burn/jadwal, WBS, timesheet, change request (DoA), transisi status. */
export default function ProjectDelivery({ projectId, status, onChanged }: { projectId: string; status: string; onChanged: () => void }) {
  const me = useMe();
  const perms = me?.permissions ?? [];
  const manager = perms.includes('project.manage');
  const d = useApi(`/api/v1/projects/${projectId}/delivery`);
  const ts = useApi(`/api/v1/projects/${projectId}/timesheets`);
  const users = useApi(manager ? '/api/v1/users' : null);
  const act = useAction();
  const [task, setTask] = useState({ name: '', parentId: '', assigneeId: '', startDate: '', dueDate: '', plannedMd: '' });
  const [sheet, setSheet] = useState({ workDate: today(), md: '1', taskId: '', note: '' });
  const [cr, setCr] = useState({ title: '', description: '', reason: '', valueDelta: '', mdDelta: '', scheduleDeltaDays: '' });
  const [holdNote, setHoldNote] = useState('');
  const [msg, setMsg] = useState('');
  if (d.loading || !d.data) return <div className="card"><ErrorBox error={d.error} /><Loading /></div>;
  const m = d.data.metrics;
  const reloadAll = () => { d.reload(); ts.reload(); onChanged(); };
  const post = (path: string, body: any, ok?: string) => act.run(async () => { const r = await api(`/api/v1/projects/${projectId}/${path}`, { body }); if (ok) setMsg(ok); reloadAll(); return r; });
  const patchTask = (tid: string, body: any) => act.run(async () => { await api(`/api/v1/projects/${projectId}/tasks/${tid}`, { method: 'PATCH', body }); d.reload(); });
  const staff = (users.data?.items ?? []).filter((u: any) => u.role !== 'customer_user');
  const canLog = perms.includes('project.timesheet') && ['KICKOFF', 'IN_PROGRESS', 'CLOSING'].includes(status);
  return (
    <>
      <div className="card">
        <h2>Delivery</h2>
        <ErrorBox error={act.error} />
        {msg && <div className="alert ok">{msg}</div>}
        <div className="grid g4">
          <div className="kpi"><div className="l">Progres (tertimbang MD)</div><div className="v">{m.progressPct}%</div><div className="l">waktu berjalan {m.elapsedPct}%</div></div>
          <div className="kpi"><div className="l">Varians jadwal</div><div className="v" style={{ color: m.scheduleVariancePct < -10 ? 'var(--bad, #b42318)' : undefined }}>{m.scheduleVariancePct > 0 ? '+' : ''}{m.scheduleVariancePct}%</div><div className="l">{m.overdueTasks} task lewat tenggat</div></div>
          <div className="kpi"><div className="l">MD aktual / budget</div><div className="v">{m.actualMd} / {m.budgetMd ?? '—'}</div><div className="l">rencana WBS {m.plannedMd} MD · menunggu {m.pendingMd}</div></div>
          <div className="kpi"><div className="l">Burn effort</div><div className="v" style={{ color: (m.burnPct ?? 0) > m.progressPct + 15 ? 'var(--bad, #b42318)' : undefined }}>{m.burnPct ?? '—'}%</div><div className="l">vs progres {m.progressPct}%</div></div>
        </div>
        {manager && d.data.allowedTransitions.length > 0 && (
          <div className="row" style={{ marginTop: 8 }}>
            {d.data.allowedTransitions.includes('ON_HOLD') && <input placeholder="Alasan tunda" value={holdNote} onChange={(e) => setHoldNote(e.target.value)} aria-label="Alasan tunda" style={{ maxWidth: 220 }} />}
            {d.data.allowedTransitions.map((s: string) => (
              <button key={s} className={`btn sm ${s === 'CLOSED' ? 'ok' : 'sec'}`} disabled={act.busy || (s === 'ON_HOLD' && !holdNote)} onClick={() => post('status', { status: s, note: s === 'ON_HOLD' ? holdNote : undefined }, `Status proyek: ${s}`)}>{s.replace('_', ' ')}</button>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>WBS</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>WBS</th><th>Task</th><th>PIC</th><th>Tenggat</th><th className="r">MD rencana / aktual</th><th>Progres</th></tr></thead>
          <tbody>{d.data.tasks.map((t: any) => {
            const mine = t.assigneeId === me?.id;
            return (
              <tr key={t.id}><td className="mono">{t.wbsCode}</td><td>{t.name}</td><td className="sub">{t.assigneeName ?? '—'}</td>
                <td className="sub">{t.dueDate ? String(t.dueDate).slice(0, 10) : '—'}</td><td className="r">{Number(t.plannedMd)} / {Number(t.actualMd)}</td>
                <td>{(manager || mine) && t.status !== 'DONE' ? (
                  <div className="row"><select value={t.progressPct} onChange={(e) => patchTask(t.id, { progressPct: Number(e.target.value) })} aria-label={`Progres ${t.wbsCode}`}>
                    {[0, 10, 25, 50, 75, 90, 100].map((v) => <option key={v} value={v}>{v}%</option>)}</select>
                    <select value={t.status} onChange={(e) => patchTask(t.id, { status: e.target.value })} aria-label={`Status ${t.wbsCode}`}>{['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'].map((s) => <option key={s}>{s}</option>)}</select></div>
                ) : <><Badge s={t.status} /> {t.progressPct}%</>}</td></tr>
            );
          })}
          {!d.data.tasks.length && <tr><td colSpan={6} className="empty">Belum ada task</td></tr>}</tbody></table></div>
        {manager && status !== 'CLOSED' && (
          <div style={{ marginTop: 8 }}>
            <h3>Tambah task</h3>
            <div className="grid g3">
              <Field label="Nama task"><input value={task.name} onChange={(e) => setTask({ ...task, name: e.target.value })} /></Field>
              <Field label="Induk (opsional)"><select value={task.parentId} onChange={(e) => setTask({ ...task, parentId: e.target.value })}><option value="">— level teratas —</option>
                {d.data.tasks.map((t: any) => <option key={t.id} value={t.id}>{t.wbsCode} {t.name}</option>)}</select></Field>
              <Field label="PIC"><select value={task.assigneeId} onChange={(e) => setTask({ ...task, assigneeId: e.target.value })}><option value="">—</option>{staff.map((u: any) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select></Field>
              <Field label="Mulai"><input type="date" value={task.startDate} onChange={(e) => setTask({ ...task, startDate: e.target.value })} /></Field>
              <Field label="Tenggat"><input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} /></Field>
              <Field label="MD rencana"><input type="number" min={0} step={0.5} value={task.plannedMd} onChange={(e) => setTask({ ...task, plannedMd: e.target.value })} /></Field>
            </div>
            <button className="btn sec" disabled={act.busy || task.name.length < 2} onClick={() => act.run(async () => {
              await api(`/api/v1/projects/${projectId}/tasks`, { body: { name: task.name, parentId: task.parentId || undefined, assigneeId: task.assigneeId || undefined,
                startDate: task.startDate || undefined, dueDate: task.dueDate || undefined, plannedMd: task.plannedMd ? Number(task.plannedMd) : undefined } });
              setTask({ name: '', parentId: '', assigneeId: '', startDate: '', dueDate: '', plannedMd: '' }); d.reload();
            })}>Tambah task</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Timesheet proyek</h2>
        {canLog && (
          <>
            <div className="grid g3">
              <Field label="Tanggal"><input type="date" max={today()} value={sheet.workDate} onChange={(e) => setSheet({ ...sheet, workDate: e.target.value })} /></Field>
              <Field label="MD (maks 1,5/hari)"><input type="number" min={0.25} max={1.5} step={0.25} value={sheet.md} onChange={(e) => setSheet({ ...sheet, md: e.target.value })} /></Field>
              <Field label="Task"><select value={sheet.taskId} onChange={(e) => setSheet({ ...sheet, taskId: e.target.value })}><option value="">— umum —</option>{d.data.tasks.map((t: any) => <option key={t.id} value={t.id}>{t.wbsCode} {t.name}</option>)}</select></Field>
            </div>
            <Field label="Catatan"><input value={sheet.note} onChange={(e) => setSheet({ ...sheet, note: e.target.value })} /></Field>
            <button className="btn sec" disabled={act.busy} onClick={() => post('timesheets', { workDate: sheet.workDate, md: Number(sheet.md), taskId: sheet.taskId || undefined, note: sheet.note || undefined }, 'Timesheet tercatat — menunggu persetujuan PM')}>Catat timesheet</button>
          </>
        )}
        <div className="table-wrap" style={{ marginTop: 8 }}><table className="t"><thead><tr><th>Tanggal</th><th>Personel</th><th>Task</th><th className="r">MD</th><th>Status</th></tr></thead>
          <tbody>{(ts.data?.items ?? []).slice(0, 50).map((t: any) => (
            <tr key={t.id}><td>{String(t.workDate).slice(0, 10)}</td><td>{t.userName}<div className="sub">{t.note}</div></td><td className="sub">{t.wbsCode ? `${t.wbsCode} ${t.taskName}` : '—'}</td><td className="r">{Number(t.md)}</td>
              <td><Badge s={t.status} />{manager && t.status === 'SUBMITTED' && t.userId !== me?.id && <div className="row" style={{ marginTop: 4 }}>
                <button className="btn ok sm" disabled={act.busy} onClick={() => post(`timesheets/${t.id}/decide`, { decision: 'APPROVE' })}>Setujui</button>
                <button className="btn bad sm" disabled={act.busy} onClick={() => post(`timesheets/${t.id}/decide`, { decision: 'REJECT' })}>Tolak</button></div>}</td></tr>
          ))}{!ts.data?.items.length && <tr><td colSpan={5} className="empty">Belum ada</td></tr>}</tbody></table></div>
      </div>

      <div className="card">
        <h2>Change request</h2>
        {d.data.changeRequests.map((c: any) => (
          <div key={c.id} className="list-item">
            <div className="row"><b className="mono">{c.number}</b><span>{c.title}</span><span className="spacer" /><Badge s={c.status} /></div>
            <div className="sub">Δ nilai {idr(c.valueDelta)} · Δ effort {Number(c.mdDelta)} MD · Δ jadwal {c.scheduleDeltaDays} hari · {c.createdByName} {dt(c.createdAt)}</div>
            {c.approvalRequestId && <Link href={`/approvals/${c.approvalRequestId}`} className="sub">Lihat approval</Link>}
            {manager && c.status === 'DRAFT' && <button className="btn pur sm" style={{ marginTop: 4 }} disabled={act.busy} onClick={() => post(`change-requests/${c.id}/submit`, {}, `${c.number} diajukan ke approval DoA`)}>Ajukan approval</button>}
          </div>
        ))}
        {!d.data.changeRequests.length && <div className="empty">Belum ada</div>}
        {manager && status !== 'CLOSED' && (
          <div style={{ marginTop: 8 }}>
            <h3>Buat change request</h3>
            <Field label="Judul"><input value={cr.title} onChange={(e) => setCr({ ...cr, title: e.target.value })} /></Field>
            <Field label="Deskripsi perubahan"><textarea value={cr.description} onChange={(e) => setCr({ ...cr, description: e.target.value })} /></Field>
            <Field label="Alasan"><input value={cr.reason} onChange={(e) => setCr({ ...cr, reason: e.target.value })} /></Field>
            <div className="grid g3">
              <Field label="Δ nilai (Rp, boleh negatif)"><input type="number" value={cr.valueDelta} onChange={(e) => setCr({ ...cr, valueDelta: e.target.value })} /></Field>
              <Field label="Δ effort (MD)"><input type="number" value={cr.mdDelta} onChange={(e) => setCr({ ...cr, mdDelta: e.target.value })} /></Field>
              <Field label="Δ jadwal (hari)"><input type="number" value={cr.scheduleDeltaDays} onChange={(e) => setCr({ ...cr, scheduleDeltaDays: e.target.value })} /></Field>
            </div>
            <button className="btn sec" disabled={act.busy || cr.title.length < 3 || cr.description.length < 10 || cr.reason.length < 5} onClick={() => act.run(async () => {
              await api(`/api/v1/projects/${projectId}/change-requests`, { body: { title: cr.title, description: cr.description, reason: cr.reason,
                valueDelta: Number(cr.valueDelta || 0), mdDelta: Number(cr.mdDelta || 0), scheduleDeltaDays: Number(cr.scheduleDeltaDays || 0) } });
              setCr({ title: '', description: '', reason: '', valueDelta: '', mdDelta: '', scheduleDeltaDays: '' }); setMsg('Change request dibuat (DRAFT)'); d.reload();
            })}>Simpan CR</button>
          </div>
        )}
      </div>
    </>
  );
}
