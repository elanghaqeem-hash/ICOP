import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { config } from './config.js';
import { createSql, type Sql } from './db.js';
import { AppError } from './lib/errors.js';
import { AiDisabledError } from './modules/ai/gateway.js';
import './lib/context.js';
import { authRoutes } from './modules/auth/routes.js';
import { mfaRecoveryRoutes } from './modules/auth/recovery.js';
import { mfaChallengeRequired } from './modules/auth/policy.js';
import { crmRoutes } from './modules/crm/routes.js';
import { pricingRoutes } from './modules/pricing/routes.js';
import { quotationRoutes } from './modules/quotations/routes.js';
import { aiRoutes } from './modules/ai/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { tenderRoutes } from './modules/tenders/routes.js';
import { tenderAssistantReadRoutes } from './modules/tenders/assistant-read.js';
import { tenderComplianceRoutes } from './modules/tenders/assistant-compliance.js';
import { proposalRoutes } from './modules/proposals/routes.js';
import { vendorRoutes } from './modules/vendors/routes.js';
import multipart from '@fastify/multipart';
import { documentRoutes } from './modules/documents/routes.js';
import { contractRoutes } from './modules/contracts/routes.js';
import { flexguardRoutes } from './modules/flexguard/routes.js';
import { templateRoutes } from './modules/templates/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';
import { billingRoutes } from './modules/billing/routes.js';
import { deliveryRoutes } from './modules/delivery/routes.js';
import { helpdeskRoutes } from './modules/helpdesk/routes.js';
import { setMailTransportOverride } from './lib/mailer.js';
import { setEsignFetch } from './modules/contracts/esign.js';
import { setFeedFetch } from './modules/tenders/feed.js';
import type { Transporter } from 'nodemailer';
import { setDocumentAiFetch } from './modules/documents/service.js';
import type { FetchLike } from './modules/ai/providers.js';

export interface BuildOptions { sql?: Sql; logger?: boolean; aiFetch?: FetchLike; mailTransport?: Transporter | null; outboundFetch?: (url: string, init?: RequestInit) => Promise<Response> }

const PASSWORD_CHANGE_ALLOWED = new Set(['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout-all']);
const MFA_CHALLENGE_ALLOWED = new Set([
  '/api/v1/auth/me', '/api/v1/auth/logout-all', '/api/v1/auth/change-password',
  '/api/v1/auth/mfa/setup', '/api/v1/auth/mfa/enable', '/api/v1/auth/mfa/verify', '/api/v1/auth/mfa/step-up',
]);

export async function buildApp(opts: BuildOptions = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const sql = opts.sql ?? createSql();
  app.decorate('sql', sql);
  app.decorateRequest('authUser', null as never);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: config.allowedOrigins, credentials: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl, iss: 'icop-cb360' }, verify: { allowedIss: 'icop-cb360' } });
  await app.register(swagger, {
    openapi: { info: { title: 'ICOP CyberBusiness 360 API', version: '1.3.0-phase4', description: 'REST API — DefendIT360' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, security: [{ bearer: [] }] },
  });
  if (config.swaggerUiEnabled) await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(multipart, { limits: { fileSize: Number(process.env.DOC_MAX_MB ?? 50) * 1024 * 1024, files: 1, fields: 10 } });

  // Simpan raw body JSON (verifikasi HMAC webhook e-sign)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch (e) { (e as { statusCode?: number }).statusCode = 400; done(e as Error, undefined); }
  });

  app.decorate('authenticate', async (req) => {
    let payload;
    try { payload = await req.jwtVerify<{ sub: string; tid: string; tv: number; role: string; mfa?: boolean; mfaAt?: number; purpose?: string }>(); } catch { throw new AppError(401, 'UNAUTHENTICATED', 'Sesi tidak valid atau kedaluwarsa'); }
    const [u] = await sql`SELECT id, tenant_id, role, email, full_name, customer_id, token_version, is_active,
                                 force_password_change, mfa_enabled
                          FROM users WHERE id = ${payload.sub} AND tenant_id = ${payload.tid}`;
    if (!u || !u.isActive || u.tokenVersion !== payload.tv) throw new AppError(401, 'UNAUTHENTICATED', 'Sesi sudah dicabut');
    if (u.forcePasswordChange && !PASSWORD_CHANGE_ALLOWED.has(req.routeOptions.url ?? '')) {
      throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Ganti password terlebih dahulu');
    }
    const route = req.routeOptions.url ?? '';
    const enrolled = !!u.mfaEnabled;
    const needed = mfaChallengeRequired(String(u.role), enrolled);
    const verified = enrolled && payload.mfa === true && !payload.purpose;
    // A password-only or MFA-pending token MUST NOT access the business API,
    // even if it was issued before a role/tenant policy changed.
    if ((payload.purpose || (needed && !verified)) && !MFA_CHALLENGE_ALLOWED.has(route)) {
      throw new AppError(403, 'MFA_REQUIRED', 'Verifikasi dua faktor diperlukan');
    }
    req.authUser = { id: u.id as string, tenantId: u.tenantId as string, role: u.role as string, email: u.email as string,
      fullName: u.fullName as string, customerId: (u.customerId as string) ?? null, tv: u.tokenVersion as number,
      mfaEnrolled: enrolled, mfaVerified: needed ? verified : !payload.purpose,
      mfaAt: verified && Number.isFinite(payload.mfaAt) ? Number(payload.mfaAt) : undefined };
  });

  app.setErrorHandler((err: FastifyError | AppError | ZodError, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Input tidak valid', details: err.flatten() });
    if (err instanceof AppError) return reply.code(err.statusCode).send({ code: err.code, message: err.message, details: err.details });
    if (err instanceof AiDisabledError) return reply.code(409).send({ code: 'AI_DISABLED', message: err.message, details: { feature: err.feature } });
    const pgCode = (err as unknown as { code?: string }).code;
    if (pgCode === '23505') return reply.code(409).send({ code: 'DUPLICATE', message: 'Data duplikat' });
    if (pgCode === '23503') return reply.code(400).send({ code: 'INVALID_REFERENCE', message: 'Referensi data tidak valid' });
    if (pgCode === '22P02') return reply.code(400).send({ code: 'BAD_REQUEST', message: 'Format parameter tidak valid' });
    if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      return reply.code((err as FastifyError).statusCode!).send({ code: (err as FastifyError).code ?? 'ERROR', message: err.message });
    }
    req.log.error(err);
    return reply.code(500).send({ code: 'INTERNAL', message: 'Terjadi kesalahan internal' });
  });

  app.get('/health', async () => {
    const [r] = await sql`SELECT 1 AS ok, (SELECT count(*)::int FROM schema_migrations) AS migrations`;
    return { status: 'ok', db: r.ok === 1, migrations: r.migrations, version: '1.3.0-phase4' };
  });

  await app.register(authRoutes);
  await app.register(mfaRecoveryRoutes);
  await app.register(crmRoutes);
  await app.register(pricingRoutes);
  await app.register(quotationRoutes);
  await app.register(aiRoutes, { fetchImpl: opts.aiFetch });
  await app.register(dashboardRoutes);
  await app.register(tenderRoutes, { fetchImpl: opts.aiFetch });
  await app.register(tenderAssistantReadRoutes);
  await app.register(tenderComplianceRoutes, {fetchImpl: opts.aiFetch});
  await app.register(proposalRoutes, { fetchImpl: opts.aiFetch });
  await app.register(vendorRoutes);
  await app.register(documentRoutes);
  await app.register(contractRoutes);
  await app.register(flexguardRoutes);
  await app.register(templateRoutes);
  await app.register(integrationRoutes);
  await app.register(billingRoutes);
  await app.register(deliveryRoutes);
  await app.register(helpdeskRoutes);
  setDocumentAiFetch(opts.aiFetch);
  if (opts.mailTransport !== undefined) setMailTransportOverride(opts.mailTransport);
  setEsignFetch(opts.outboundFetch);
  setFeedFetch(opts.outboundFetch);

  app.addHook('onClose', async () => { if (!opts.sql) await sql.end({ timeout: 5 }); });
  return app;
}
