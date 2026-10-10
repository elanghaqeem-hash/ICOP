import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Safe public deployment signal. Configured means an explicit backend URL
 * exists; it does not mean the API, migrations, database or login work.
 * Do not disclose API hostname, keys, or customer data.
 */
export function GET() {
  const configured = Boolean(process.env.API_INTERNAL_URL?.trim());
  return NextResponse.json({
    frontend: 'UP',
    backend: configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
    readyForBusiness: false,
    note: 'Frontend availability is not proof of API/database readiness or release approval',
  }, { status: 200, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
