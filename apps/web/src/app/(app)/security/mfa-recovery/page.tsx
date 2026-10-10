'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, dt } from '@/lib/api';
import { ErrorBox, Field, Loading, PageHead, useAction, useMe } from '@/components/ui';

type RecoveryTarget = { id: string; email: string; fullName: string; role: string };
type RecoveryItem = {
  id: string; status: string; targetUserId: string; targetEmail: string;
  targetName: string; requestedBy: string; reason: string;
  createdAt: string; expiresAt: string; decidedAt: string | null;
};

export default function MfaRecoveryPage() {
  const me = useMe();
  const [targets, setTargets] = useState<RecoveryTarget[]>([]);
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const [lastError, setLastError] = useState<string | null>(null);
  const act = useAction();

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api<{ items: RecoveryTarget[] }>('/api/v1/auth/mfa/recovery-targets'),
        api<{ items: RecoveryItem[] }>('/api/v1/auth/mfa/recovery-requests'),
      ]);
      setTargets(a.items); setItems(b.items);
      setReady(true); setLastError(null);
    } catch (e) {
      setReady(true);
      setLastError(e instanceof ApiError ? e.message : 'Tidak dapat memuat daftar pemulihan');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const stepUp = () => act.run(async () => {
    await api('/api/v1/auth/mfa/step-up', { body: { code } });
    setCode(''); setNotice('MFA berhasil diverifikasi ulang.');
    await load();
  });
  const submit = () => act.run(async () => {
    await api('/api/v1/auth/mfa/recovery-requests', { body: { targetUserId: target, reason } });
    setTarget(''); setReason(''); setNotice('Permintaan dicatat. Administrator kedua harus menyetujuinya.');
    await load();
  });
  const decide = (id: string, decision: 'approve' | 'reject') => act.run(async () => {
    await api(`/api/v1/auth/mfa/recovery-requests/${id}/${decision}`, { body: {} });
    setNotice(decision === 'approve'
      ? 'MFA akun telah direset. Semua sesi lama dicabut; password dan MFA wajib diatur ulang.'
      : 'Permintaan pemulihan ditolak.');
    await load();
  });

  return <>
    <PageHead title="Pemulihan MFA" crumbs={<Link href="/settings">Pengaturan</Link>}
      sub="Dual-control: dua administrator berbeda, verifikasi MFA terbaru, dan jejak audit." />
    {notice && <div className="alert ok">{notice}</div>}
    <div className="card">
      <h3>Verifikasi administrator</h3>
      <p className="sub">Kode baru diperlukan setiap lima menit sebelum tindakan pemulihan.</p>
      <ErrorBox error={act.error} />
      <Field label="Kode authenticator (6 digit)">
        <input value={code} inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
          autoComplete="one-time-code" onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} />
      </Field>
      <button className="btn sec" disabled={act.busy || code.length !== 6} onClick={stepUp}>
        Verifikasi ulang MFA
      </button>
    </div>
    {lastError && <div className="alert warn">{lastError} — verifikasi ulang MFA di atas lalu muat data.</div>}
    {!ready ? <Loading /> : <>
      <div className="card">
        <h3>Ajukan pemulihan MFA</h3>
        <p className="sub">Tidak dapat digunakan untuk akun sendiri. Sertakan alasan dan bukti identifikasi di proses internal; jangan memasukkan password atau kunci rahasia.</p>
        <Field label="Akun sasaran">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Pilih akun dengan MFA aktif</option>
            {targets.map((u) => <option value={u.id} key={u.id}>{u.fullName} · {u.email} ({u.role})</option>)}
          </select>
        </Field>
        <Field label="Alasan pemulihan (min. 20 karakter)">
          <textarea value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)}
            placeholder="Contoh: perangkat authenticator hilang; identitas telah diverifikasi melalui prosedur internal…" />
        </Field>
        <button className="btn" disabled={act.busy || !target || reason.trim().length < 20} onClick={submit}>
          Ajukan untuk persetujuan administrator kedua
        </button>
      </div>
      <div className="card">
        <h3>Antrean & riwayat pemulihan</h3>
        {!items.length && <p className="sub">Belum ada permintaan.</p>}
        {items.map((r) => {
          const canDecide = r.status === 'PENDING' && r.requestedBy !== me?.id && r.targetUserId !== me?.id &&
            new Date(r.expiresAt).getTime() > Date.now();
          return <div className="step" key={r.id} style={{ display: 'block', marginBottom: 12 }}>
            <div><strong>{r.targetName}</strong> · {r.targetEmail}</div>
            <div className="sub">Status: {r.status} · Diajukan: {dt(r.createdAt)} · Batas: {dt(r.expiresAt)}</div>
            <p style={{ margin: '6px 0' }}>{r.reason}</p>
            {canDecide && <div className="row">
              <button className="btn ok" disabled={act.busy} onClick={() => decide(r.id, 'approve')}>
                Setujui reset MFA
              </button>
              <button className="btn bad" disabled={act.busy} onClick={() => decide(r.id, 'reject')}>
                Tolak
              </button>
            </div>}
          </div>;
        })}
      </div>
    </>}
  </>;
}
