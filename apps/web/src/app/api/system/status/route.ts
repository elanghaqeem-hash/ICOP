import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StagingBinding = { fetch(request: Request): Promise<Response> };
type ApiReadiness = {
  status?: string;
  environment?: string;
  capabilities?: { authentication?: boolean };
};

function stagingStatusBinding(): StagingBinding | null {
  try {
    const runtime = getCloudflareContext();
    return (runtime.env as unknown as {
      ICOP_STAGING_STATUS?: StagingBinding;
    }).ICOP_STAGING_STATUS ?? null;
  } catch {
    return null; // Plain Next.js/Docker and local CI have no Cloudflare binding.
  }
}

function status(backend: string) {
  // This public endpoint reports deployment status, NOT authorization or
  // business readiness. Never return internal URLs, errors or tenant data.
  return NextResponse.json({
    frontend: 'UP',
    backend,
    readyForBusiness: false,
    note: 'Staging connectivity does not indicate ICOP login, MFA, tenant data or business modules are operational',
  }, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function GET() {
  const binding = stagingStatusBinding();
  if (binding) {
    try {
      // This is the ONLY request using the staging-only service binding.
      // Do not route login/password requests through it or bypass Access.
      const response = await binding.fetch(new Request(
        'https://icop-staging-api.internal/api/v1/system/readiness',
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(4000),
        },
      ));
      if (!response.ok ||
          !response.headers.get('content-type')?.includes('application/json')) {
        return status('STAGING_UNREACHABLE');
      }
      const readiness = (await response.json()) as ApiReadiness;
      if (readiness.environment !== 'staging' ||
          readiness.status !== 'bootstrap_only' ||
          readiness.capabilities?.authentication !== false) {
        return status('STAGING_UNVERIFIED');
      }
      return status('STAGING_CONNECTED_AUTH_DISABLED');
    } catch {
      return status('STAGING_UNREACHABLE');
    }
  }
  return status(process.env.API_INTERNAL_URL?.trim()
    ? 'CONFIGURED_UNVERIFIED'
    : 'NOT_CONFIGURED');
}
