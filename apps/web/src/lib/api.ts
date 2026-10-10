'use client';

/**
 * Browser session metadata is memory-only. The bearer JWT lives exclusively in
 * the BFF's httpOnly cookie and is never exposed through client JavaScript.
 * On a full reload, Shell fetches /auth/me from the BFF to restore identity.
 */
export interface Session { user: { id: string; email: string; fullName: string; role: string; customerId: string | null; forcePasswordChange?: boolean } }
let currentSession: Session | null = null;
export function getSession(): Session | null { return currentSession; }
export function setSession(session: Session | null) { currentSession = session; }

function csrfHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const values = document.cookie.split('; ');
  for (const name of ['__Host-icop-csrf', 'icop-dev-csrf']) {
    const raw = values.find((c) => c.startsWith(name + '='));
    if (raw) return { 'x-icop-csrf': decodeURIComponent(raw.slice(name.length + 1)) };
  }
  return {};
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) Object.assign(headers, csrfHeaders());
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/login')) { setSession(null); window.location.href = '/login'; }
    if (res.status === 403 && data?.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined') window.location.href = '/change-password';
    const serviceMessages: Record<string, string> = {
      API_NOT_CONFIGURED: 'Layanan ICOP belum terhubung ke server backend. Silakan hubungi administrator.',
      API_ORIGIN_INVALID: 'Konfigurasi koneksi server ICOP tidak valid. Silakan hubungi administrator.',
      API_UNAVAILABLE: 'Server ICOP belum dapat dijangkau. Coba lagi nanti atau hubungi administrator.',
    };
    const code = typeof data?.code === 'string' ? data.code : 'ERROR';
    throw new ApiError(res.status, code, serviceMessages[code] ?? data?.message ?? `HTTP ${res.status}`, data?.details ?? data?.attempts);
  }
  return data as T;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
export const idr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : 'Rp ' + Number(n).toLocaleString('id-ID', { maximumFractionDigits: 0 }));
export const jt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : 'Rp ' + (Number(n) / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' jt');
export const dt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) : '—');
export const can = (perms: string[] | undefined, p: string) => !!perms?.includes(p);

export const STATUS_TONE: Record<string, string> = {
  DRAFT: '', IN_APPROVAL: 'warn', APPROVED: 'ok', ISSUED: 'pur', SENT: 'pur', ACCEPTED: 'ok', REJECTED: 'bad', EXPIRED: 'bad',
  REVISION_REQUESTED: 'warn', PENDING: 'warn', SUPERSEDED: '', WON: 'ok', LOST: 'bad', REVIEWED: 'ok', ENGINEER_REVIEW_REQUIRED: 'warn',
};

/** Authenticated multipart upload via the same-origin BFF. */
export async function apiUpload<T = any>(path: string, form: FormData): Promise<T> {
  const res = await fetch(path, { method: 'POST', body: form, headers: csrfHeaders(), credentials: 'same-origin', cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'ERROR', data?.message ?? `HTTP ${res.status}`, data?.details);
  return data as T;
}

/** Unduh file terautentikasi (DOCX, CSV, dokumen tender). */
export async function apiDownload(path: string, fallbackName: string) {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new ApiError(res.status, d?.code ?? 'ERROR', d?.message ?? `HTTP ${res.status}`); }
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

Object.assign(STATUS_TONE, {
  DISCOVERED: '', SCREENING: '', REGISTERED: 'pur', BID_DECISION: 'warn', PREPARING: 'pur', INTERNAL_REVIEW: 'warn', SUBMITTED: 'pur', CLARIFICATION: 'warn',
  NEGOTIATION: 'warn', AWARDED: 'ok', CONTRACTING: 'ok', NO_BID: 'bad', CANCELLED: 'bad', COMPLY: 'ok', PARTIAL: 'warn', NON_COMPLY: 'bad', NOT_APPLICABLE: '',
  CLARIFY: 'warn', UNREVIEWED: '', GO: 'ok', CONDITIONAL_GO: 'warn', NO_GO: 'bad', IN_REVIEW: 'warn', GENERATED: '', AI_DRAFT: 'pur', EDITED: 'ok', FLAGGED: 'bad',
  EMPTY: '', QUEUED: '', PROCESSING: 'warn', READY: 'ok', OCR_QUEUED: 'warn', OCR_RUNNING: 'warn', RUNNING: 'warn', LEGAL_REVIEW: 'warn', PENDING_SIGNATURE: 'pur', COMPLETED: 'ok', TERMINATED: 'bad',
  SUBMITTED_SR: '', SCOPED: '', PENDING_CUSTOMER_APPROVAL: 'warn', IN_PROGRESS: 'pur', DELIVERED: 'pur', DISPUTED: 'bad', HANDOVER: 'warn', KICKOFF: 'pur', SIGNED: 'warn', CLOSED: '', SUSPENDED: 'bad',
  FUND: 'ok', TOPUP: 'ok', BONUS: 'ok', RESERVE: 'warn', RELEASE: '', CONSUME: 'pur', REVERSAL: 'warn', ADJUSTMENT: 'warn', EXPIRE: 'bad', ROLLOVER: '', DONE: 'ok', NEEDS_OCR: 'warn', FAILED: 'bad', VERIFIED: 'ok', UNVERIFIED: 'warn', ANSWERED: 'ok', AUTHORIZED: 'ok', EXPIRED: 'bad', ACTIVE: 'ok', RETIRED: '',
});
Object.assign(STATUS_TONE, { P1: 'bad', P2: 'warn', P3: 'pur', P4: '', OPEN: 'warn', WAITING_CUSTOMER: 'warn', RESOLVED: 'ok', TODO: '', BLOCKED: 'bad', PARTIAL: 'warn', PAID: 'ok', OVERDUE: 'bad', VOID: '', PENDING_LEGAL: 'warn', ON_HOLD: 'warn', CLOSING: 'pur' });
