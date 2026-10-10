'use client';
import { useState } from 'react';
import { api, dt } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, useAction, useApi } from './ui';

/** Menu Integrasi (Company Admin): e-sign VIDA/Privy, object storage S3/MinIO, feed tender, API key layanan, target SLA. */
export default function IntegrationsSettings() {
  const list = useApi('/api/v1/integrations');
  if (list.loading || !list.data) return <div className="card"><ErrorBox error={list.error} /><Loading /></div>;
  return (
    <>
      {list.data.items.map((it: any) => <IntegrationCard key={it.kind} it={it} storage={list.data.storage} onSaved={list.reload} />)}
      <ApiKeys />
      <SlaTargets />
    </>
  );
}

function IntegrationCard({ it, storage, onSaved }: { it: any; storage: any; onSaved: () => void }) {
  const act = useAction();
  const [cfg, setCfg] = useState<Record<string, any>>(it.config ?? {});
  const [sec, setSec] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean>(it.enabled);
  const [msg, setMsg] = useState('');
  const save = () => act.run(async () => {
    await api(`/api/v1/integrations/${it.kind}`, { method: 'PUT', body: { enabled, config: cfg, secrets: sec } });
    setSec({}); setMsg('Tersimpan'); onSaved();
  });
  const test = () => act.run(async () => { const r = await api(`/api/v1/integrations/${it.kind}/test`, { body: {} }); setMsg(`${r.ok ? 'Berhasil' : 'Gagal'}: ${r.message}`); onSaved(); });
  const sync = () => act.run(async () => { const r = await api('/api/v1/integrations/STORAGE_S3/sync', { body: {} }); setMsg(`Sinkronisasi: ${r.uploaded} diunggah, ${r.skipped} sudah ada, ${r.missingLocal} file lokal tidak ditemukan`); onSaved(); });
  const run = () => act.run(async () => { const r = await api('/api/v1/integrations/TENDER_FEED/run', { body: {} }); setMsg(`Feed: ${r.received} item, ${r.created.length} tender baru, ${r.duplicates.length} duplikat, ${r.invalid} tidak valid`); onSaved(); });
  return (
    <div className="card" data-integration={it.kind}>
      <div className="row"><h2 style={{ margin: 0 }}>{it.label}</h2><span className="spacer" />
        {it.status === 'CREDENTIALS_ONLY' && <span className="badge warn">menunggu spesifikasi API</span>}
        {it.enabled ? <span className="badge ok">aktif</span> : <span className="badge">nonaktif</span>}</div>
      <p className="sub">{it.description}</p>
      {it.lastTestAt && <div className={`alert ${it.lastTestOk ? 'ok' : 'bad'}`}>Uji terakhir {dt(it.lastTestAt)}: {it.lastTestMessage}</div>}
      {it.kind === 'STORAGE_S3' && storage && <div className="sub">{storage.objects} objek tereplikasi ({(storage.bytes / 1048576).toFixed(1)} MB)</div>}
      {it.kind === 'TENDER_FEED' && it.lastRunAt && <div className="sub">Terakhir ditarik {dt(it.lastRunAt)}</div>}
      <ErrorBox error={act.error} />
      {msg && <div className="alert info">{msg}</div>}
      <label className="check" style={{ padding: '6px 0', fontWeight: 600 }}><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aktifkan</label>
      <div className="grid g2">
        {it.configFields.map((f: any) => (
          <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
            {f.type === 'boolean' ? <label className="check"><input type="checkbox" checked={!!cfg[f.key]} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.checked })} /> Ya</label>
              : f.type === 'select' ? <select value={cfg[f.key] ?? f.options[0]} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>{f.options.map((o: string) => <option key={o}>{o}</option>)}</select>
              : <input type={f.type === 'number' ? 'number' : 'text'} value={cfg[f.key] ?? ''} placeholder={f.placeholder ?? ''} onChange={(e) => setCfg({ ...cfg, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} />}
          </Field>
        ))}
        {it.secretFields.map((f: any) => (
          <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
            <input type="password" autoComplete="new-password" value={sec[f.key] ?? ''} placeholder={it.secretHint?.includes(`${f.key}:`) ? 'Tersimpan — kosongkan bila tidak diganti' : ''}
              onChange={(e) => setSec({ ...sec, [f.key]: e.target.value })} aria-label={f.label} />
          </Field>
        ))}
      </div>
      {it.secretHint && <div className="sub">Rahasia tersimpan terenkripsi: {it.secretHint}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" disabled={act.busy} onClick={save}>Simpan</button>
        {it.configured && <button className="btn sec" disabled={act.busy} onClick={test}>Uji koneksi</button>}
        {it.kind === 'STORAGE_S3' && it.enabled && <button className="btn sec" disabled={act.busy} onClick={sync}>Sinkronkan file lama</button>}
        {it.kind === 'TENDER_FEED' && it.enabled && <button className="btn sec" disabled={act.busy} onClick={run}>Tarik sekarang</button>}
      </div>
    </div>
  );
}

function ApiKeys() {
  const keys = useApi('/api/v1/integrations/api-keys');
  const customers = useApi('/api/v1/customers?limit=100');
  const act = useAction();
  const [f, setF] = useState({ name: '', scope: 'INGEST_SOC', customerId: '' });
  const [created, setCreated] = useState<any>(null);
  const create = () => act.run(async () => {
    setCreated(await api('/api/v1/integrations/api-keys', { body: { name: f.name, scope: f.scope, customerId: f.customerId || undefined } }));
    setF({ ...f, name: '' }); keys.reload();
  });
  return (
    <div className="card">
      <h2>API key layanan (ingest SOC / VAPT)</h2>
      <p className="sub">Untuk sistem SIEM/SOC dan scanner VAPT mengirim alert/temuan ke Helpdesk: <span className="mono">POST /api/v1/ingest/soc-alerts</span> atau <span className="mono">/vapt-findings</span> dengan header <span className="mono">x-api-key</span>. Key hanya ditampilkan sekali.</p>
      <ErrorBox error={act.error} />
      {created && <div className="alert warn" style={{ overflowWrap: 'anywhere' }}><b>Simpan sekarang:</b> <span className="mono">{created.apiKey}</span></div>}
      <div className="grid g3">
        <Field label="Nama sistem"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Rapid7 InsightIDR" /></Field>
        <Field label="Scope"><select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="INGEST_SOC">Alert SOC → tiket insiden</option><option value="INGEST_VAPT">Temuan VAPT → tiket kerentanan</option></select></Field>
        <Field label="Terikat ke customer (disarankan)"><select value={f.customerId} onChange={(e) => setF({ ...f, customerId: e.target.value })}><option value="">— semua (wajib kirim customerId) —</option>
          {customers.data?.items?.map((c: any) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></Field>
      </div>
      <button className="btn" disabled={act.busy || f.name.length < 3} onClick={create}>Buat API key</button>
      <div style={{ marginTop: 10 }}>
        {keys.data?.items.map((k: any) => (
          <div key={k.id} className="list-item">
            <div className="row"><b>{k.name}</b><span className="mono sub">icop_{k.keyPrefix}_…</span><span className="spacer" />{k.revokedAt ? <span className="badge bad">dicabut</span> : <span className="badge ok">aktif</span>}</div>
            <div className="sub">{k.scope} · {k.customerName ?? 'semua customer'} · dibuat {dt(k.createdAt)} · terakhir dipakai {k.lastUsedAt ? dt(k.lastUsedAt) : '—'}</div>
            {!k.revokedAt && <button className="btn bad sm" style={{ marginTop: 4 }} disabled={act.busy} onClick={() => { if (window.confirm(`Cabut API key ${k.name}?`)) act.run(async () => { await api(`/api/v1/integrations/api-keys/${k.id}/revoke`, { body: {} }); keys.reload(); }); }}>Cabut</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SlaTargets() {
  const sla = useApi('/api/v1/helpdesk/sla');
  const act = useAction();
  const [edit, setEdit] = useState<Record<string, { response: number; resolution: number }>>({});
  const [msg, setMsg] = useState('');
  if (!sla.data) return null;
  const val = (p: string, k: 'response' | 'resolution') => edit[p]?.[k] ?? sla.data.items.find((x: any) => x.priority === p)[k];
  const save = () => act.run(async () => {
    await api('/api/v1/helpdesk/sla', { method: 'PUT', body: { items: sla.data.items.map((x: any) => ({ priority: x.priority, response: Number(val(x.priority, 'response')), resolution: Number(val(x.priority, 'resolution')) })) } });
    setMsg('Target SLA tersimpan'); setEdit({}); sla.reload();
  });
  return (
    <div className="card">
      <h2>Target SLA helpdesk (menit)</h2>
      <ErrorBox error={act.error} />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="table-wrap"><table className="t"><thead><tr><th>Prioritas</th><th>Respons</th><th>Resolusi</th></tr></thead><tbody>
        {sla.data.items.map((x: any) => (
          <tr key={x.priority}><td><Badge s={x.priority} /></td>
            <td><input type="number" min={1} value={val(x.priority, 'response')} onChange={(e) => setEdit({ ...edit, [x.priority]: { response: Number(e.target.value), resolution: val(x.priority, 'resolution') } })} aria-label={`Respons ${x.priority}`} /></td>
            <td><input type="number" min={1} value={val(x.priority, 'resolution')} onChange={(e) => setEdit({ ...edit, [x.priority]: { response: val(x.priority, 'response'), resolution: Number(e.target.value) } })} aria-label={`Resolusi ${x.priority}`} /></td></tr>
        ))}</tbody></table></div>
      <button className="btn" disabled={act.busy || !Object.keys(edit).length} onClick={save}>Simpan target SLA</button>
    </div>
  );
}
