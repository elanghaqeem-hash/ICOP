'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, setSession } from '@/lib/api';
import { ErrorBox, useAction } from '@/components/ui';
import './login.css';

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2a10.7 10.7 0 011.4-.1c4.8 0 8.6 3.1 10 6.9a11.4 11.4 0 01-3.5 4.7" />
      <path d="M6.1 6.2A11.2 11.2 0 002 12c1.4 3.8 5.2 6.9 10 6.9 1.5 0 2.9-.3 4.1-.9" />
      <path d="M10 10a3 3 0 004 4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { busy, error, run } = useAction();
  const router = useRouter();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    void run(async () => {
      // Keep the existing tenant, API contract, session handling, and MFA routing.
      const r = await api('/api/v1/auth/login', { body: { tenant: 'DEIT', email, password } });
      setSession(r);
      router.replace(r.user.forcePasswordChange ? '/change-password' : r.mfaRequired ? '/mfa' : r.user.role === 'customer_user' ? '/portal' : '/');
    });
  };

  return (
    <div className="auth-layout">
      <aside className="auth-showcase" aria-label="ICOP CyberBusiness 360">
        <div className="auth-showcase__orb" aria-hidden="true" />
        <div className="auth-showcase__inner">
          <div className="auth-brand" aria-label="ICOP CyberBusiness 360">
            <span className="auth-brand__mark" aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="auth-brand__name">
              <strong>ICOP</strong>
              <small>CYBERBUSINESS 360</small>
            </span>
          </div>
          <div className="auth-showcase__copy">
            <span className="auth-eyebrow">DEFENDIT360 WORKSPACE</span>
            <h1>Bisnis siber yang terhubung. <span>Dalam satu platform.</span></h1>
            <p>Ruang kerja terpadu untuk mengelola hubungan pelanggan, penawaran, tender, dan delivery layanan cybersecurity serta IT.</p>
            <div className="auth-showcase__modules" aria-label="Area kerja ICOP">
              <span>CRM &amp; Pipeline</span>
              <span>Pricing &amp; Quotation</span>
              <span>Tender &amp; Delivery</span>
            </div>
          </div>
          <p className="auth-showcase__foot">ICOP CyberBusiness 360 · DefendIT360</p>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-form-shell">
          <div className="auth-topline"><span className="auth-topline__dot" /> Akses akun perusahaan</div>
          <form className="auth-card" onSubmit={submit}>
            <div className="auth-card__heading">
              <h2>Selamat datang kembali</h2>
              <p>Masuk menggunakan akun perusahaan Anda untuk melanjutkan pekerjaan di ICOP.</p>
            </div>
            <ErrorBox error={error} />

            <div className="auth-field">
              <label htmlFor="icop-login-email">Alamat email</label>
              <input
                id="icop-login-email"
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="nama@perusahaan.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={busy}
              />
            </div>

            <div className="auth-field">
              <label htmlFor="icop-login-password">Kata sandi</label>
              <div className="auth-password">
                <input
                  id="icop-login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="Masukkan kata sandi"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={busy}
                />
                <button
                  type="button"
                  className="auth-password__toggle"
                  onClick={() => setShowPassword((current) => !current)}
                  aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Lihat kata sandi'}
                  aria-pressed={showPassword}
                  aria-controls="icop-login-password"
                >
                  <PasswordVisibilityIcon visible={showPassword} />
                </button>
              </div>
            </div>

            <button className="auth-submit" type="submit" disabled={busy} aria-busy={busy}>
              <span>{busy ? 'Sedang masuk…' : 'Masuk ke ICOP'}</span>
              {!busy && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14m-6-6l6 6-6 6" />
                </svg>
              )}
            </button>
            <p className="auth-lock-note">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              <span>Demi keamanan, akun terkunci sementara selama 15 menit setelah 5 kali gagal masuk.</span>
            </p>
          </form>
          <p className="auth-main__footer">ICOP CyberBusiness 360 · Internal workspace</p>
        </div>
      </main>
    </div>
  );
}
