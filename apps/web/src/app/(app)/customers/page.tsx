'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Badge, ErrorBox, Field, Loading, PageHead, useAction, useApi, useMe } from '@/components/ui';

const INDUSTRIES = ['banking', 'bpd', 'bpr_bprs', 'insurance', 'capital_market', 'multifinance', 'fintech', 'government', 'bumn', 'manufacturing', 'telecommunication', 'logistics', 'energy', 'healthcare', 'education', 'other'];

export default function Customers() {
  const me = useMe();
  const [q, setQ] = useState('');
  const [show, setShow] = useState(false);
  const { data, error, loading, reload } = useApi(`/api/v1/customers?q=${encodeURIComponent(q)}`, [q]);
  const [f, setF] = useState({ legalName: '', brandName: '', industry: 'banking', classification: 'B2B', clientTier: 'A', npwp: '', city: '', address: '' });
  const act = useAction();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    act.run(async () => {
      const body: any = { ...f };
      for (const k of Object.keys(body)) if (body[k] === '') delete body[k];
      await api('/api/v1/customers', { body });
      setShow(false); setF({ ...f, legalName: '', brandName: '', npwp: '', city: '', address: '' }); reload();
    });
  };
  return (
    <>
      <PageHead title="Customer" sub="Customer master — satu customer, banyak opportunity" actions={me?.permissions.includes('customer.write') && <button className="btn pur" onClick={() => setShow(!show)}>{show ? 'Tutup' : '+ Customer'}</button>} />
      {show && (
        <form className="card" onSubmit={save}>
          <h2>Customer baru</h2>
          <ErrorBox error={act.error} />
          <div className="grid g2">
            <Field label="Nama badan usaha *"><input required minLength={2} value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
            <Field label="Brand"><input value={f.brandName} onChange={(e) => setF({ ...f, brandName: e.target.value })} /></Field>
            <Field label="Industri"><select value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })}>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</select></Field>
            <Field label="Klasifikasi"><select value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}><option>B2B</option><option>B2G</option><option>B2B2B</option></select></Field>
            <Field label="Client tier (BRD §8.1)"><select value={f.clientTier} onChange={(e) => setF({ ...f, clientTier: e.target.value })}>
              <option value="S">S — Premium (Bank BUKU III/IV, BUMN strategis)</option><option value="A">A — Standard (BPD, multifinance)</option>
              <option value="B">B — Value (BPR, fintech, SME)</option><option value="C">C — Overseas</option><option value="D">D — Gov/Tender</option><option value="E">E — Channel</option></select></Field>
            <Field label="NPWP"><input value={f.npwp} placeholder="01.234.567.8-901.000" onChange={(e) => setF({ ...f, npwp: e.target.value })} /></Field>
            <Field label="Kota"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
            <Field label="Alamat"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          </div>
          <button className="btn" disabled={act.busy}>Simpan</button>
        </form>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div style={{ padding: 10 }}><input placeholder="Cari nama / kode…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Cari customer" /></div>
        <ErrorBox error={error} />
        {loading ? <div style={{ padding: 10 }}><Loading /></div> : data?.items.length === 0 ? <div className="empty">Belum ada customer</div> :
          data?.items.map((c: any) => (
            <Link key={c.id} href={`/customers/${c.id}`} className="list-item">
              <div className="row"><b>{c.legalName}</b><span className="spacer" /><Badge s={`Tier ${c.clientTier}`} /></div>
              <div className="sub">{c.code} · {c.industry} · {c.classification} · {c.onboardingStatus} · {c.openOpportunities} opp aktif · AM {c.accountOwner ?? '—'}</div>
            </Link>
          ))}
      </div>
    </>
  );
}
