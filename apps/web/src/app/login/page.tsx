'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, setSession } from '@/lib/api';
import { ErrorBox, Field, useAction } from '@/components/ui';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const router = useRouter();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/v1/auth/login', { body: { tenant: 'DEIT', email, password } });
      setSession(r);
      router.replace(r.user.forcePasswordChange ? '/change-password' : r.mfaRequired ? '/mfa' : r.user.role === 'customer_user' ? '/portal' : '/');
    });
  };
  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>ICOP CyberBusiness 360</h1>
        <p className="sub">DefendIT360 — masuk dengan akun perusahaan</p>
        <ErrorBox error={error} />
        <Field label="Email"><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn" style={{ width: '100%' }} disabled={busy}>{busy ? 'Memproses…' : 'Masuk'}</button>
        <p className="sub" style={{ marginTop: 10 }}>Akun terkunci 15 menit setelah 5 kali gagal login.</p>
      </form>
    </div>
  );
}
