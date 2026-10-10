'use client';
import { useEffect, useState } from 'react';
import { api, dt } from '@/lib/api';
import { ErrorBox, Field, Loading, useAction, useApi, useMe } from './ui';

/** Form admin: registrasi API key (terenkripsi), urutan failover, model, aktivasi provider, dan aktivasi AI per fitur. */
export default function AiSettings() {
  const me = useMe();
  const isAdmin = !!me?.permissions.includes('ai.admin');
  const prov = useApi('/api/v1/ai/providers');
  const feat = useApi('/api/v1/ai/features');
  const act = useAction();
  const [order, setOrder] = useState<string[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<Record<string, { model?: string; baseUrl?: string; timeoutMs?: number }>>({});
  const [tests, setTests] = useState<Record<string, any>>({});
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState('');

  useEffect(() => { if (prov.data) setOrder(prov.data.items.map((p: any) => p.provider)); }, [prov.data]);
  useEffect(() => { if (feat.data) setToggles(Object.fromEntries(feat.data.items.map((f: any) => [f.feature, f.enabled]))); }, [feat.data]);

  if (prov.loading || !prov.data) return <div className="card"><Loading /></div>;
  const byId = Object.fromEntries(prov.data.items.map((p: any) => [p.provider, p]));
  const orderChanged = order.join() !== prov.data.items.map((p: any) => p.provider).join();
  const move = (i: number, d: -1 | 1) => { const o = [...order]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; setOrder(o); };
  const flash = (m: string) => { setSaved(m); setTimeout(() => setSaved(''), 4000); };

  const saveKey = (p: string, testNow: boolean) => act.run(async () => {
    const r = await api(`/api/v1/ai/providers/${p}/key`, { method: 'PUT', body: { apiKey: keys[p], enable: true, testNow } });
    setKeys({ ...keys, [p]: '' });
    if (r.test) setTests({ ...tests, [p]: r.test });
    flash(`API key ${byId[p].label} tersimpan (${r.keyMasked})`);
    prov.reload();
  });
  const removeKey = (p: string) => { if (window.confirm(`Hapus API key ${byId[p].label} dari database?`)) act.run(async () => { await api(`/api/v1/ai/providers/${p}/key`, { method: 'DELETE' }); prov.reload(); }); };
  const patch = (p: string, body: any) => act.run(async () => { await api(`/api/v1/ai/providers/${p}`, { method: 'PATCH', body }); prov.reload(); });
  const test = (p: string) => act.run(async () => { setTests({ ...tests, [p]: await api(`/api/v1/ai/providers/${p}/test`, { body: {} }) }); prov.reload(); });
  const saveOrder = () => act.run(async () => { await api('/api/v1/ai/providers/order', { method: 'PUT', body: { order } }); flash('Urutan failover disimpan'); prov.reload(); });
  const saveFeatures = () => act.run(async () => { await api('/api/v1/ai/features', { method: 'PUT', body: { features: toggles } }); flash('Aktivasi fitur AI disimpan'); feat.reload(); });
  const areas = feat.data ? [...new Set(feat.data.items.filter((f: any) => f.feature !== 'global').map((f: any) => f.area))] as string[] : [];

  return (
    <>
      <div className="card">
        <h2>Provider AI & API key</h2>
        <p className="sub">{prov.data.readyCount} provider siap. Urutan aktif: {prov.data.failoverOrder.join(' → ') || '—'}. {prov.data.note}</p>
        <ErrorBox error={act.error} />
        {saved && <div className="alert ok">{saved}</div>}
        {order.map((id, i) => {
          const p = byId[id];
          const t = tests[id];
          return (
            <div key={id} className="card" style={{ background: '#fafbfd' }} data-provider={id}>
              <div className="row">
                <span className="badge pur">#{i + 1}</span><b>{p.label}</b>
                {p.ready ? <span className="badge ok">siap</span> : !p.enabled ? <span className="badge">nonaktif</span> : <span className="badge bad">belum ada key</span>}
                {p.circuit.state !== 'CLOSED' && <span className="badge warn">circuit {p.circuit.state}</span>}
                <span className="spacer" />
                {isAdmin && <><button className="btn sec sm" aria-label="Naikkan" disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                  <button className="btn sec sm" aria-label="Turunkan" disabled={i === order.length - 1} onClick={() => move(i, 1)}>▼</button></>}
              </div>
              <div className="sub" style={{ marginTop: 4 }}>
                Key: {p.keyMasked ? <b className="mono">{p.keyMasked}</b> : '—'}{p.keySource ? ` (${p.keySource === 'database' ? 'tersimpan terenkripsi' : 'dari environment server'})` : ''}
                {p.keyUpdatedAt ? ` · diperbarui ${dt(p.keyUpdatedAt)}` : ''} · {p.last7d.calls} panggilan 7 hari{p.circuit.lastError ? ` · error terakhir: ${p.circuit.lastError.slice(0, 80)}` : ''}
              </div>
              {t && <div className={`alert ${t.ok ? 'ok' : 'bad'}`} style={{ marginTop: 6 }}>{t.ok ? `Koneksi OK — ${t.model}, ${t.latencyMs} ms` : `Gagal: ${t.attempts?.[0]?.skipped ?? t.attempts?.[0]?.error ?? 'tidak diketahui'}`}</div>}
              {isAdmin && (
                <>
                  <div className="grid g2" style={{ marginTop: 8 }}>
                    <Field label={`API key ${p.label}`}>
                      <input type="password" autoComplete="new-password" spellCheck={false} placeholder={p.keyMasked ? 'Ganti key…' : 'Tempel API key'} value={keys[id] ?? ''}
                        onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} aria-label={`API key ${p.label}`} />
                    </Field>
                    <Field label="Model">
                      <input value={edit[id]?.model ?? p.model} onChange={(e) => setEdit({ ...edit, [id]: { ...edit[id], model: e.target.value } })} aria-label={`Model ${p.label}`} />
                    </Field>
                    {id === 'custom' && <Field label="Base URL (OpenAI-compatible, HTTPS)"><input value={edit[id]?.baseUrl ?? p.baseUrl ?? ''} placeholder="https://llm.internal/v1"
                      onChange={(e) => setEdit({ ...edit, [id]: { ...edit[id], baseUrl: e.target.value } })} /></Field>}
                    <Field label="Timeout (detik)"><input type="number" min={2} max={120} value={Math.round((edit[id]?.timeoutMs ?? p.timeoutMs) / 1000)}
                      onChange={(e) => setEdit({ ...edit, [id]: { ...edit[id], timeoutMs: Number(e.target.value) * 1000 } })} /></Field>
                  </div>
                  <div className="row">
                    <button className="btn pur sm" disabled={act.busy || (keys[id] ?? '').length < 8} onClick={() => saveKey(id, true)}>Simpan key & uji</button>
                    <button className="btn sec sm" disabled={act.busy || (keys[id] ?? '').length < 8} onClick={() => saveKey(id, false)}>Simpan key</button>
                    {edit[id] && <button className="btn sec sm" disabled={act.busy} onClick={() => { patch(id, { ...edit[id], baseUrl: edit[id].baseUrl === '' ? null : edit[id].baseUrl }); setEdit({ ...edit, [id]: undefined as never }); }}>Simpan model/URL</button>}
                    <button className="btn sec sm" disabled={act.busy} onClick={() => test(id)}>Uji koneksi</button>
                    <button className="btn sec sm" disabled={act.busy} onClick={() => patch(id, { enabled: !p.enabled })}>{p.enabled ? 'Nonaktifkan' : 'Aktifkan'}</button>
                    {p.keySource === 'database' && <button className="btn bad sm" disabled={act.busy} onClick={() => removeKey(id)}>Hapus key</button>}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {isAdmin && orderChanged && <div className="row"><button className="btn" disabled={act.busy} onClick={saveOrder}>Simpan urutan failover</button><button className="btn sec" onClick={() => setOrder(prov.data.items.map((p: any) => p.provider))}>Batalkan</button></div>}
      </div>

      <div className="card">
        <h2>Aktivasi AI per fitur</h2>
        <p className="sub">Fitur nonaktif ditolak di server (bukan hanya disembunyikan). Master switch mematikan seluruh AI.</p>
        {!feat.data ? <Loading /> : (
          <>
            {feat.data.items.filter((f: any) => f.feature === 'global').map((f: any) => (
              <label key={f.feature} className="check" style={{ padding: '6px 0', fontWeight: 600 }}>
                <input type="checkbox" disabled={!isAdmin} checked={!!toggles[f.feature]} onChange={(e) => setToggles({ ...toggles, [f.feature]: e.target.checked })} /> {f.label}
              </label>
            ))}
            {areas.map((area) => (
              <div key={area} style={{ marginTop: 8 }}>
                <h3>{area}</h3>
                {feat.data.items.filter((f: any) => f.area === area && f.feature !== 'global').map((f: any) => (
                  <label key={f.feature} className="check" style={{ padding: '4px 0', opacity: toggles.global ? 1 : 0.5 }}>
                    <input type="checkbox" disabled={!isAdmin} checked={!!toggles[f.feature]} onChange={(e) => setToggles({ ...toggles, [f.feature]: e.target.checked })} />
                    {f.label}{f.updatedByName ? <span className="sub"> · {f.updatedByName}</span> : null}
                  </label>
                ))}
              </div>
            ))}
            {isAdmin && <button className="btn" style={{ marginTop: 8 }} disabled={act.busy} onClick={saveFeatures}>Simpan aktivasi</button>}
          </>
        )}
      </div>
    </>
  );
}
