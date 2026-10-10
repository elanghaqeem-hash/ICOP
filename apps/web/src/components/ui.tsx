'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, STATUS_TONE, api } from '@/lib/api';

export interface Me { id: string; role: string; fullName: string; email: string; customerId: string | null; permissions: string[] }
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext);

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loaded = useRef<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    // Reload data yang sama tidak mengosongkan layar (hindari flicker & state form hilang); ganti path → skeleton
    if (loaded.current !== path) setLoading(true);
    try { setData(await api<T>(path)); setError(null); loaded.current = path; } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Jalankan aksi dengan state busy + pesan error yang manusiawi. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) {
      const d = e instanceof ApiError && e.details && typeof e.details === 'object' ? (e.details as any).fieldErrors : null;
      setError((e as Error).message + (d ? ' — ' + Object.entries(d).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`).join('; ') : ''));
    } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

export const Badge = ({ s, label }: { s: string; label?: string }) => <span className={`badge ${STATUS_TONE[s] ?? ''}`}>{label ?? s.replace(/_/g, ' ')}</span>;
export const ErrorBox = ({ error }: { error: string | null }) => (error ? <div className="alert bad" role="alert">{error}</div> : null);
export const Loading = () => (<><div className="skeleton" /><div className="skeleton" /></>);

export function PageHead({ title, crumbs, sub, actions }: { title: string; crumbs?: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="top">
      <div style={{ minWidth: 0 }}>
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
