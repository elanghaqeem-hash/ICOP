import { Container, getContainer } from '@cloudflare/containers';
import { env as workerEnv } from 'cloudflare:workers';

/**
 * Internal-only Cloudflare API gateway. The public Next.js Worker calls this
 * through an ICOP_API Service Binding. Do not expose a workers.dev route.
 * The Fastify application in apps/api runs unchanged inside a Linux Container.
 *
 * Bootstrap requirements: managed PostgreSQL with approved migrations,
 * Cloudflare Workers Paid (Containers), and secrets configured for icop-api.
 */
type IcopEnvironment = {
  ICOP_CONTAINER: DurableObjectNamespace<IcopApiContainer>;
  DATABASE_URL: string;
  JWT_SECRET: string;
  SECRETS_MASTER_KEY: string;
  ALLOWED_ORIGINS: string;
};

const settings = workerEnv as unknown as IcopEnvironment;

export class IcopApiContainer extends Container {
  defaultPort = 3001;
  sleepAfter = '30m';
  envVars = {
    NODE_ENV: 'production',
    PORT: '3001',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
    TRUST_PROXY: 'false',
    API_DOCS_ENABLED: 'false',
    ESIGN_SANDBOX_ENABLED: 'false',
    // The existing setInterval-based worker is not a Cloudflare Cron/Queue.
    // Keep it disabled until a separately-tested background worker is deployed.
    SCHEDULER_ENABLED: 'false',
    JOB_WORKER_ENABLED: 'false',
    DATABASE_URL: settings.DATABASE_URL,
    JWT_SECRET: settings.JWT_SECRET,
    SECRETS_MASTER_KEY: settings.SECRETS_MASTER_KEY,
    ALLOWED_ORIGINS: settings.ALLOWED_ORIGINS,
  };
}

const noStore = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request: Request, env: IcopEnvironment): Promise<Response> {
    const { pathname } = new URL(request.url);
    // No admin shell, migrations, OpenAPI, or worker health meta-endpoints.
    if (!(pathname === '/health' && request.method === 'GET') &&
        !pathname.startsWith('/api/v1/')) {
      return new Response(JSON.stringify({ code: 'NOT_FOUND' }), { status: 404, headers: noStore });
    }

    // Fail closed BEFORE starting the Container if the secrets/database are absent.
    if (!env.DATABASE_URL || !env.JWT_SECRET || env.JWT_SECRET.length < 32 ||
        !env.SECRETS_MASTER_KEY || !env.ALLOWED_ORIGINS ||
        env.ALLOWED_ORIGINS.includes('*')) {
      return new Response(JSON.stringify({ code: 'API_BOOTSTRAP_INCOMPLETE' }),
        { status: 503, headers: noStore });
    }

    try {
      // One instance only in the initial gate: rate limits and cron/background jobs
      // must be redesigned and tested before horizontal scale-out.
      return await getContainer(env.ICOP_CONTAINER, 'icop-primary').fetch(request);
    } catch {
      return new Response(JSON.stringify({ code: 'API_UNAVAILABLE' }),
        { status: 502, headers: noStore });
    }
  },
};
