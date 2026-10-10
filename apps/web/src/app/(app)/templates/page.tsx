'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

export default function Templates() {
  const me = useMe();
  const { data, error, loading, reload } = useApi('/api/v1/templates');
  const [sel, setSel] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [quotationId, setQuotationId] = useState('');
  const [out, setOut] = useState<any>(null);
  const [note, setNote] = useState('');
  const act = useAction();
  const t = data?.items.find((x: any) => x.code === sel);
  const render = () => act.run(async () => setOut(await api(`/api/v1/templates/${sel}/render`, { body: { values, quotationId: quotationId || undefined } })));
  const approve = () => act.run(async () => { await api(`/api/v1/templates/${sel}/approve`, { body: { note } }); setNote(''); reload(); render(); });
  const printOut = () => { const w = window.open('', '_blank'); if (w) { w.document.write(out.html); w.document.close(); w.focus(); w.print(); } };
  return (
    <>
      <PageHead title="Template legal" sub="Standar praktik profesional: UU ITE, UU PDP, Perpres PBJ, KUHPerdata. Wajib disahkan Legal sebelum dipakai." />
      <ErrorBox error={error} />
      {loading ? <Loading /> : (
        <div className="grid g2">
          <div className="card" style={{ padding: 0 }}>
            {data?.items.map((x: any) => (
              <button key={x.code} className="list-item" style={{ width: '100%', textAlign: 'left', background: sel === x.code ? '#f1f3fa' : undefined }} onClick={() => { setSel(x.code); setOut(null); setValues({}); }}>
                <div className="row"><b>{x.title}</b><span className="spacer" /><Badge s={x.status} label={x.status === 'APPROVED' ? 'DISAHKAN' : 'MENUNGGU LEGAL'} /></div>
                <div className="sub">{x.category} · v{x.version}</div>
              </button>
            ))}
          </div>
          {t && (
            <div className="card">
              <h2>{t.title}</h2>
              <p className="sub">Dasar hukum: {t.legalBasis}</p>
              <Field label="Isi otomatis dari quotation (ID, opsional)"><input value={quotationId} onChange={(e) => setQuotationId(e.target.value)} placeholder="ID quotation" /></Field>
              {t.fields.map((f: any) => (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                  {f.multiline ? <textarea value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} /> : <input value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
                </Field>
              ))}
              <div className="row">
                <button className="btn" disabled={act.busy} onClick={render}>Pratinjau</button>
                {out && <button className="btn sec" onClick={printOut}>Cetak / PDF</button>}
              </div>
              <ErrorBox error={act.error} />
              {out && out.missing.length > 0 && <div className="alert warn" style={{ marginTop: 8 }}>Belum lengkap: {out.missing.join(', ')}</div>}
              {me?.permissions.includes('template.approve') && t.status !== 'APPROVED' && (
                <div style={{ marginTop: 10 }}>
                  <Field label="Catatan pengesahan Legal (min. 10 karakter)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <button className="btn ok" disabled={act.busy || note.length < 10} onClick={approve}>Sahkan template</button>
                </div>
              )}
              {out && <iframe title="Pratinjau template" srcDoc={out.html} style={{ width: '100%', minHeight: 520, border: '1px solid #e2e5ee', borderRadius: 8, marginTop: 10, background: '#fff' }} />}
            </div>
          )}
        </div>
      )}
    </>
  );
}
