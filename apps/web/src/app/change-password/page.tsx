'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, getSession, setSession } from '@/lib/api';
import { ErrorBox, Field, useAction } from '@/components/ui';

const RULES: [string, (s: string) => boolean][] = [
  ['Minimal 12 karakter', (s) => s.length >= 12], ['Huruf besar', (s) => /[A-Z]/.test(s)], ['Huruf kecil', (s) => /[a-z]/.test(s)],
  ['Angka', (s) => /\d/.test(s)], ['Simbol', (s) => /[^A-Za-z0-9]/.test(s)],
];

export default function ChangePassword() {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const { busy, error, run } = useAction();
  const router = useRouter();
  const valid = RULES.every(([, f]) => f(pw)) && pw === pw2;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/v1/auth/change-password', { body: { currentPassword: cur, newPassword: pw } });
      const s = getSession();
      if (s) setSession({ token: r.token, user: { ...s.user, forcePasswordChange: false } });
      router.replace(s?.user.role === 'customer_user' ? '/portal' : '/');
    });
  };
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Ganti password</h1>
        <p className="sub">Wajib saat login pertama. Semua sesi lama akan dicabut.</p>
        <ErrorBox error={error} />
        <Field label="Password saat ini"><input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
        <Field label="Password baru"><input type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Ulangi password baru"><input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: '.84rem' }}>
          {RULES.map(([l, f]) => <li key={l} style={{ color: f(pw) ? 'var(--ok)' : 'var(--muted)' }}>{l}</li>)}
          <li style={{ color: pw && pw === pw2 ? 'var(--ok)' : 'var(--muted)' }}>Konfirmasi cocok</li>
        </ul>
        <button className="btn" style={{ width: '100%' }} disabled={!valid || busy}>Simpan password</button>
      </form>
    </div>
  );
}
