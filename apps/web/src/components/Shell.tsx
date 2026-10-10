'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { api, setSession } from '@/lib/api';
import { MeContext, type Me } from './ui';

const NAV = [
  { href: '/', label: 'Dashboard', ico: '▦', perm: 'dashboard.read', mobile: true },
  { href: '/pipeline', label: 'Pipeline', ico: '◧', perm: 'opportunity.read', mobile: true },
  { href: '/customers', label: 'Customer', ico: '◉', perm: 'customer.read', mobile: false },
  { href: '/tenders', label: 'Tender', ico: '⚑', perm: 'tender.read', mobile: true },
  { href: '/quotations', label: 'Quotation', ico: '▤', perm: 'quotation.read', mobile: false },
  { href: '/contracts', label: 'Kontrak', ico: '§', perm: 'contract.read', mobile: false },
  { href: '/projects', label: 'Proyek', ico: '▶', perm: 'project.read', mobile: false },
  { href: '/flexguard', label: 'FlexGuard', ico: '◈', perm: 'flexguard.read', mobile: false },
  { href: '/documents', label: 'Dokumen', ico: '▢', perm: 'documents.read', mobile: false },
  { href: '/helpdesk', label: 'Helpdesk', ico: '☎', perm: 'helpdesk.read', mobile: false },
  { href: '/helpdesk/settings', label: 'Kalender SLA', ico: '◷', perm: 'helpdesk.read', mobile: false },
  { href: '/billing', label: 'Tagihan', ico: '¤', perm: 'billing.read', mobile: false },
  { href: '/templates', label: 'Template legal', ico: '¶', perm: 'template.read', mobile: false },
  { href: '/approvals', label: 'Approval', ico: '✓', perm: 'approval.read', mobile: true },
  { href: '/assistant', label: 'AI Assistant', ico: '✦', perm: 'ai.use', mobile: true },
  { href: '/vendors', label: 'Vendor & BOM', ico: '▣', perm: 'vendor.read', mobile: false },
  { href: '/settings', label: 'Kebijakan & AI', ico: '⚙', perm: 'policy.read', mobile: false },
  { href: '/security/mfa-recovery', label: 'Pemulihan MFA', ico: '🔐', perm: 'user.manage', mobile: false },
  { href: '/audit', label: 'Audit trail', ico: '≡', perm: 'audit.read', mobile: false },
  { href: '/portal', label: 'Penawaran', ico: '▤', perm: 'portal.access', mobile: true },
  { href: '/portal/flexguard', label: 'FlexGuard', ico: '◈', perm: 'portal.access', mobile: true },
  { href: '/portal/contracts', label: 'Kontrak', ico: '§', perm: 'portal.access', mobile: true },
  { href: '/portal/invoices', label: 'Tagihan', ico: '¤', perm: 'portal.access', mobile: true },
  { href: '/portal/tickets', label: 'Bantuan', ico: '☎', perm: 'portal.access', mobile: true },
];

export default function Shell({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState(0);
  const path = usePathname();
  const router = useRouter();

  useEffect(() => {
    // Validate the server cookie on every page load; memory metadata is not
    // an authentication source of truth (including after a hard refresh).
    api<Me>('/api/v1/auth/me').then((m) => {
      setSession({ user: { id: m.id, email: m.email, fullName: m.fullName, role: m.role, customerId: m.customerId } });
      setMe(m);
      if ((m as Me & { mfaRequired?: boolean }).mfaRequired) { router.replace('/mfa'); return; }
      if (m.role === 'customer_user' && !path.startsWith('/portal')) router.replace('/portal');
      if (m.permissions.includes('approval.decide')) api('/api/v1/approvals').then((r) => setPending(r.items.length)).catch(() => {});
    }).catch(() => {});
  }, [router, path]);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  if (!me) return <div className="main"><div className="skeleton" /><div className="skeleton" /></div>;
  const items = NAV.filter((n) => me.permissions.includes(n.perm));
  const isOn = (h: string) => (h === '/' ? path === '/' : h === '/portal' ? path === '/portal' || /^\/portal\/[0-9a-f-]{36}$/.test(path) : path.startsWith(h));
  const logout = async () => {
    try { await api('/api/v1/auth/logout', { method: 'POST' }); }
    catch (error) { console.error('ICOP logout failed', error); return; }
    setSession(null);
    router.replace('/login');
  };

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <nav className="side" aria-label="Navigasi utama">
          <div className="brand">ICOP CyberBusiness 360<small>DefendIT360</small></div>
          {items.map((n) => (
            <Link key={n.href} href={n.href} className={isOn(n.href) ? 'active' : ''}>
              <span>{n.ico}&nbsp; {n.label}</span>{n.href === '/approvals' && pending > 0 && <span className="dot">{pending}</span>}
            </Link>
          ))}
          <div className="foot">{me.fullName}<br />{me.role.replace(/_/g, ' ')}<br /><button type="button" onClick={logout} className="logout-btn" style={{ color: '#cfd6e6', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>Keluar</button></div>
        </nav>
        <main className="main">{children}</main>
        <nav className="bottom" aria-label="Navigasi cepat">
          {items.filter((n) => n.mobile).slice(0, 5).map((n) => (
            <Link key={n.href} href={n.href} className={isOn(n.href) ? 'active' : ''}>
              <span className="ico">{n.ico}</span>{n.label.split(' ')[0]}{n.href === '/approvals' && pending > 0 && <span className="dot">{pending}</span>}
            </Link>
          ))}
        </nav>
      </div>
    </MeContext.Provider>
  );
}
