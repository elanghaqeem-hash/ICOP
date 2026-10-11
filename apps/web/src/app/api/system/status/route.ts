import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = 'NOT_BOUND' | 'CONNECTED_BOOTSTRAP_ONLY' | 'UNAVAILABLE';

async function stagingReadiness(): Promise<Status> {
  let binding: { fetch(request: Request): Promise<Response> } | undefined;
  try {
    // Only the read-only staging health signal is permitted via this binding.
    // It is NEVER used by the credential/session BFF.
    const context = getCloudflareContext();
    binding = (context.env as unknown as {
      ICOP_READINESS?: { fetch(request: Request): Promise<Response> };
    }).ICOP_READINESS;
  } catch {
    // Local Next.js and bare CI runs have no Cloudflare context.
    return 'NOT_BOUND';
  }
  if (!binding) return 'NOT_BOUND';
  try {
    const request = new Request('https://icop-staging-api.internal/api/v1/system/readiness', {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const response = await binding.fetch(request);
    if (!response.ok) return 'UNAVAILABLE';
    const status: unknown = await response.json();
    if (
      typeof status === 'object' && status !== null &&
      'status' in status && status.status === 'bootstrap_only' &&
      'environment' in status && status.environment === 'staging' &&
      'database' in status && status.database === 'ready'
    ) return 'CONNECTED_BOOTSTRAP_ONLY';
  } catch {
    // A failed probe does not disable the frontend or expose internal errors.
  }
  return 'UNAVAILABLE';
}

/**
 * Public, sanitized development status. Cloudflare D1 bootstrap reachability
 * is NOT ICOP application auth or business API readiness.
 * Never return worker addresses, identities, secrets, or raw upstream JSON.
 */
export async function GET() {
  const configured = Boolean(process.env.API_INTERNAL_URL?.trim());
  const stagingConnection = await stagingReadiness();
  return NextResponse.json({
    frontend: 'UP',
    backend: configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
    stagingConnection,
    readyForBusiness: false,
    note: 'Staging bootstrap connectivity does not enable application login, MFA, CRM or production operation',
  }, { status: 200, headers: {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  } });
}
