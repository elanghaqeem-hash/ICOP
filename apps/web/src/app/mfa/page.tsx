'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setSession } from '@/lib/api';
import { ErrorBox, Field, useAction } from '@/components/ui';

type Me = { id: string; email: string; role: string; fullName: string; customerId: string | null;
  mfaRequired: boolean; mfaEnrolled: boolean; mfaVerified: boolean; };
type Setup = { secret: string; otpauthUri: string; expiresInSeconds: number };

export default function MfaChallengePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<Me>('/api/v1/auth/me').then((user) => {
      setMe(user);
      if (!user.mfaRequired && user.mfaVerified) router.replace(user.role === 'customer_user' ? '/portal' : '/');
    }).catch(() => {});
  }, [router]);

  const begin = () => run(async () => {
    const result = await api<Setup>('/api/v1/auth/mfa/setup', { body: {} });
    setSetup(result);
    setNotice('Tambahkan kunci ini ke aplikasi authenticator. Kunci hanya ditampilkan pada proses pendaftaran.');
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (!me) return;
      const response = await api<{ user: { id: string; email: string; fullName: string; role: string; customerId: string | null; forcePasswordChange: boolean } }>(
        me.mfaEnrolled ? '/api/v1/auth/mfa/verify' : '/api/v1/auth/mfa/enable',
        { body: { code } },
      );
      setSession({ user: response.user });
      setCode('');
      setSetup(null);
      router.replace(response.user.role === 'customer_user' ? '/portal' : '/');
      router.refresh();
    });
  };

  if (!me) return <div className="login-wrap"><div className="card login-card"><p>Memeriksa sesi aman…</p></div></div>;
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Verifikasi dua faktor</h1>
        <p className="sub">Akun {me.email} menggunakan kode dari aplikasi authenticator.</p>
        <ErrorBox error={error} />
        {!me.mfaEnrolled && !setup && (
          <>
            <p>Daftarkan autentikator terlebih dahulu untuk melindungi akses persetujuan dan administrasi.</p>
            <button type="button" className="btn" disabled={busy} onClick={begin}>Mulai pendaftaran MFA</button>
          </>
        )}
        {setup && (
          <div style={{ wordBreak: 'break-word', margin: '12px 0' }}>
            <p className="sub">{notice}</p>
            <p><strong>Kunci rahasia:</strong></p>
            <code style={{ fontSize: '.92rem', userSelect: 'all' }}>{setup.secret}</code>
            <p className="sub">Buka Google Authenticator, Microsoft Authenticator, atau aplikasi TOTP lain.
              Tambahkan akun dengan kunci manual (berbasis waktu, 6 digit, interval 30 detik).</p>
            <p className="sub">Pendaftaran kedaluwarsa dalam 10 menit. Jangan bagikan atau tangkap layar kunci rahasia.</p>
          </div>
        )}
        {(me.mfaEnrolled || setup) && (
          <>
            <Field label="Kode autentikator 6 digit">
              <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
                autoComplete="one-time-code" required value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </Field>
            <button className="btn" style={{ width: '100%' }} disabled={busy || code.length !== 6}>
              {busy ? 'Memverifikasi…' : (me.mfaEnrolled ? 'Verifikasi dan masuk' : 'Aktifkan MFA dan masuk')}
            </button>
          </>
        )}
        <button type="button" className="btn" style={{ width: '100%', marginTop: 12, background: 'transparent', color: 'inherit' }}
          onClick={() => run(async () => {
            await api('/api/v1/auth/logout', { method: 'POST' });
            setSession(null);
            router.replace('/login');
          })}>Keluar dan kembali ke login</button>
      </form>
    </div>
  );
}
