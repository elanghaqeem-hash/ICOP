import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, requirePerm } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { AI_FEATURES, aiFeatureDefaultEnabled, AiUnavailableError, breakerState, complete, listProviders, resetBreaker, resolveKey } from './gateway.js';
import { encryptSecret, fingerprint, last4 } from '../../lib/secrets.js';
import { PROVIDER_DEFAULTS, type FetchLike, type ProviderName } from './providers.js';

const FEATURES = {
  chat: 'Internal Sales Assistant — jawab pertanyaan berdasarkan konteks opportunity.',
  opportunity_brief: 'Buat ringkasan opportunity (situasi, kebutuhan, risiko, next best action) dalam poin singkat.',
  quotation_cover: 'Susun draft paragraf pembuka surat penawaran (maks. 120 kata) berdasarkan konteks. Jangan menyebut angka harga apa pun.',
  scoping_gap: 'Identifikasi informasi scoping yang masih kurang/ambigu untuk sizing yang akurat, dan pertanyaan klarifikasi ke customer.',
  rks_summary: 'Ringkas dokumen RKS/KAK: persyaratan wajib vs opsional, dokumen administrasi, tenggat, dan risiko gugur.',
} as const;

/** Konteks permission-aware: hanya data tenant & entitas yang boleh dibaca user; TANPA biaya/margin (data minimisation ke provider eksternal). */
async function buildContext(app: FastifyInstance, tenantId: string, opportunityId?: string) {
  if (!opportunityId) return '';
  const sql = app.sql;
  const [o] = await sql`SELECT o.code, o.name, o.service_category, o.stage, o.expected_close, o.competitors, o.next_action, o.source, o.is_tender,
                               c.legal_name, c.industry, c.subsector, c.client_tier, c.existing_technologies
                        FROM opportunities o JOIN customers c ON c.id = o.customer_id WHERE o.id = ${opportunityId} AND o.tenant_id = ${tenantId}`;
  if (!o) throw notFound('Opportunity');
  const assessments = await sql`SELECT service_type, status, completeness, answers, result->'team' AS team, result->'totalMd' AS total_md,
                                        result->'effectiveEps' AS effective_eps, result->'flags' AS flags
                                 FROM assessments WHERE tenant_id = ${tenantId} AND opportunity_id = ${opportunityId}`;
  const acts = await sql`SELECT kind, subject, notes, created_at FROM activities WHERE tenant_id = ${tenantId} AND opportunity_id = ${opportunityId} ORDER BY created_at DESC LIMIT 10`;
  return JSON.stringify({ opportunity: o, assessments, recentActivities: acts }, null, 1);
}

export async function aiRoutes(app: FastifyInstance, opts: { fetchImpl?: FetchLike }) {
  const sql = app.sql;
  const auth = { onRequest: [app.authenticate] };

  const PROVIDERS = ['anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'custom'] as const;
  const ProviderParam = z.object({ provider: z.enum(PROVIDERS) });

  app.get('/api/v1/ai/providers', { ...auth, preValidation: requirePerm('ai.use') }, async (req) => {
    const t = req.authUser.tenantId;
    const rows = await listProviders(sql, t);
    const usage = await sql`SELECT provider, count(*)::int AS calls, avg(latency_ms)::int AS avg_latency_ms
                            FROM ai_calls WHERE tenant_id = ${t} AND status = 'SUCCESS' AND created_at > now() - interval '7 days' GROUP BY provider`;
    const items = rows.map((p, i) => {
      const k = resolveKey(p, process.env);
      const ready = p.enabled && (!!k.key || (p.provider === 'custom' && !!p.baseUrl));
      return {
        order: i + 1, provider: p.provider, label: PROVIDER_DEFAULTS[p.provider].label, model: p.model, priority: p.priority, enabled: p.enabled,
        apiKeyEnv: p.apiKeyEnv, keySource: k.source, keyMasked: k.source === 'database' ? p.apiKeyLast4 : k.source === 'environment' ? `env ${p.apiKeyEnv}` : null,
        keyUpdatedAt: p.keyUpdatedAt ?? null, keyConfigured: !!k.key || (p.provider === 'custom' && !!p.baseUrl), ready, baseUrl: p.baseUrl, timeoutMs: p.timeoutMs,
        circuit: breakerState(t, p.provider), last7d: usage.find((u) => u.provider === p.provider) ?? { calls: 0, avgLatencyMs: null },
      };
    });
    return { items, readyCount: items.filter((x) => x.ready).length, failoverOrder: items.filter((x) => x.ready).map((x) => x.provider),
      note: 'API key disimpan terenkripsi (AES-256-GCM) dan tidak pernah ditampilkan kembali. Bila kosong, sistem memakai environment server.' };
  });

  /** Registrasi / ganti API key dari form admin. Kunci tidak pernah dikembalikan; audit hanya mencatat fingerprint. */
  app.put('/api/v1/ai/providers/:provider/key', { ...auth, preValidation: requirePerm('ai.admin'), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { provider } = ProviderParam.parse(req.params);
    const b = z.object({ apiKey: z.string().trim().min(8, 'API key terlalu pendek').max(512).regex(/^[\x21-\x7E]+$/, 'API key mengandung karakter tidak valid'),
      enable: z.boolean().default(true), testNow: z.boolean().default(false) }).parse(req.body);
    const u = req.authUser;
    const [row] = await sql`UPDATE ai_providers SET api_key_enc = ${encryptSecret(b.apiKey)}, api_key_last4 = ${last4(b.apiKey)}, key_updated_at = now(),
        key_updated_by = ${u.id}, enabled = ${b.enable ? true : sql`enabled`}, updated_at = now()
      WHERE tenant_id = ${u.tenantId} AND provider = ${provider} RETURNING provider, api_key_last4, enabled, key_updated_at`;
    if (!row) throw notFound('Provider');
    resetBreaker(u.tenantId, provider);
    await audit(sql, u, 'ai.key_registered', 'ai_provider', provider, null, { fingerprint: fingerprint(b.apiKey), last4: row.apiKeyLast4, enabled: row.enabled }, req.ip);
    let test: unknown = null;
    if (b.testNow) test = await liveTest(req.authUser, provider);
    return { provider, keyMasked: row.apiKeyLast4, enabled: row.enabled, keyUpdatedAt: row.keyUpdatedAt, test };
  });

  app.delete('/api/v1/ai/providers/:provider/key', { ...auth, preValidation: requirePerm('ai.admin') }, async (req) => {
    const { provider } = ProviderParam.parse(req.params);
    const u = req.authUser;
    const [row] = await sql`UPDATE ai_providers SET api_key_enc = NULL, api_key_last4 = NULL, key_updated_at = now(), key_updated_by = ${u.id}
                            WHERE tenant_id = ${u.tenantId} AND provider = ${provider} RETURNING provider`;
    if (!row) throw notFound('Provider');
    await audit(sql, u, 'ai.key_removed', 'ai_provider', provider, null, null, req.ip);
    return { provider, removed: true };
  });

  /** Urutan failover: daftar provider berurutan → prioritas 10, 20, 30, … */
  app.put('/api/v1/ai/providers/order', { ...auth, preValidation: requirePerm('ai.admin') }, async (req) => {
    const b = z.object({ order: z.array(z.enum(PROVIDERS)).min(1).max(PROVIDERS.length) }).parse(req.body);
    if (new Set(b.order).size !== b.order.length) throw new AppError(400, 'BAD_REQUEST', 'Provider duplikat dalam urutan');
    const u = req.authUser;
    const all = (await listProviders(sql, u.tenantId)).map((p) => p.provider);
    const full = [...b.order, ...all.filter((p) => !b.order.includes(p))];
    await sql.begin(async (tx) => {
      for (const [i, p] of full.entries()) await tx`UPDATE ai_providers SET priority = ${(i + 1) * 10}, updated_at = now() WHERE tenant_id = ${u.tenantId} AND provider = ${p}`;
      await audit(tx, u, 'ai.failover_order', 'ai_provider', null, { order: all }, { order: full }, req.ip);
    });
    return { order: full };
  });

  /* ───── Aktivasi AI per fitur/form ───── */
  app.get('/api/v1/ai/features', { ...auth }, async (req) => {
    const rows = await sql`SELECT f.feature, f.enabled, f.updated_at, u.full_name AS updated_by_name FROM ai_features f LEFT JOIN users u ON u.id = f.updated_by
                           WHERE f.tenant_id = ${req.authUser.tenantId}`;
    const map = Object.fromEntries(rows.map((r) => [r.feature, r]));
    const globalOn = map.global?.enabled !== false;
    return { items: Object.entries(AI_FEATURES).map(([feature, meta]) => ({ feature, ...meta, enabled: map[feature]?.enabled ?? aiFeatureDefaultEnabled(feature),
      effective: feature === 'global' ? globalOn : globalOn && (map[feature]?.enabled ?? aiFeatureDefaultEnabled(feature)), updatedAt: map[feature]?.updatedAt ?? null, updatedByName: map[feature]?.updatedByName ?? null })) };
  });

  app.put('/api/v1/ai/features', { ...auth, preValidation: requirePerm('ai.admin') }, async (req) => {
    const b = z.object({ features: z.record(z.string(), z.boolean()) }).parse(req.body);
    const unknown = Object.keys(b.features).filter((k) => !AI_FEATURES[k]);
    if (unknown.length) throw new AppError(400, 'BAD_REQUEST', `Fitur tidak dikenal: ${unknown.join(', ')}`);
    const u = req.authUser;
    await sql.begin(async (tx) => {
      for (const [feature, enabled] of Object.entries(b.features)) {
        await tx`INSERT INTO ai_features (tenant_id, feature, enabled, updated_by) VALUES (${u.tenantId}, ${feature}, ${enabled}, ${u.id})
                 ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
      await audit(tx, u, 'ai.features_update', 'ai_feature', null, null, b.features, req.ip);
    });
    return { updated: Object.keys(b.features).length };
  });

  app.patch('/api/v1/ai/providers/:provider', { ...auth, preValidation: requirePerm('ai.admin') }, async (req) => {
    const { provider } = z.object({ provider: z.enum(['anthropic', 'openai', 'gemini', 'mistral', 'groq', 'openrouter', 'custom']) }).parse(req.params);
    const b = z.object({ model: z.string().min(2).max(120).optional(), priority: z.number().int().min(1).max(999).optional(), enabled: z.boolean().optional(),
      baseUrl: z.string().url().refine((u) => u.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(u), 'Wajib HTTPS (kecuali localhost)').nullable().optional(),
      timeoutMs: z.number().int().min(2000).max(120000).optional() }).parse(req.body);
    const u = req.authUser;
    const cols = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (!cols.length) throw new AppError(400, 'BAD_REQUEST', 'Tidak ada perubahan');
    const [before] = await sql`SELECT * FROM ai_providers WHERE tenant_id = ${u.tenantId} AND provider = ${provider}`;
    if (!before) throw notFound('Provider');
    const [after] = await sql`UPDATE ai_providers SET ${sql(b as Record<string, unknown>, cols)}, updated_at = now() WHERE tenant_id = ${u.tenantId} AND provider = ${provider} RETURNING *`;
    await audit(sql, u, 'ai.provider_update', 'ai_provider', provider, before, after, req.ip);
    return after;
  });

  async function liveTest(user: { tenantId: string; id: string }, provider: ProviderName) {
    try {
      const r = await complete({ sql, fetchImpl: opts.fetchImpl }, { tenantId: user.tenantId, userId: user.id, feature: 'health_check',
        system: 'Reply with exactly: OK', user: 'ping', maxTokens: 16, temperature: 0, onlyProvider: provider });
      return { provider, ok: true, model: r.model, latencyMs: r.attempts.at(-1)?.latencyMs, sample: r.text.slice(0, 40) };
    } catch (e) {
      if (e instanceof AiUnavailableError) return { provider, ok: false, attempts: e.attempts };
      throw e;
    }
  }

  /** Uji koneksi live satu provider (admin). */
  app.post('/api/v1/ai/providers/:provider/test', { ...auth, preValidation: requirePerm('ai.admin'), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { provider } = ProviderParam.parse(req.params);
    return liveTest(req.authUser, provider as ProviderName);
  });

  app.post('/api/v1/ai/complete', { ...auth, preValidation: requirePerm('ai.use'), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ feature: z.enum(Object.keys(FEATURES) as [keyof typeof FEATURES]), prompt: z.string().max(8000).default(''),
      opportunityId: z.string().uuid().optional(), document: z.string().max(60000).optional() }).parse(req.body);
    const u = req.authUser;
    const context = await buildContext(app, u.tenantId, b.opportunityId);
    const userMsg = [
      `TUGAS: ${FEATURES[b.feature]}`,
      context ? `<context>\n${context}\n</context>` : '',
      b.document ? `<document>\n${b.document}\n</document>` : '',
      b.prompt ? `PERTANYAAN/INSTRUKSI PENGGUNA:\n${b.prompt}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const r = await complete({ sql, fetchImpl: opts.fetchImpl }, { tenantId: u.tenantId, userId: u.id, feature: b.feature, user: userMsg });
      return { ...r, disclaimer: 'Draft AI — wajib ditinjau manusia sebelum digunakan.' };
    } catch (e) {
      if (e instanceof AiUnavailableError) {
        reply.code(503);
        return { code: 'AI_UNAVAILABLE', message: e.message, attempts: e.attempts };
      }
      throw e;
    }
  });

  app.get('/api/v1/ai/calls', { ...auth, preValidation: requirePerm('ai.admin') }, async (req) => {
    const rows = await sql`SELECT a.id, a.feature, a.provider, a.model, a.status, a.attempts, a.latency_ms, a.input_tokens, a.output_tokens, a.redactions, a.created_at,
                                  u.full_name AS user_name
                           FROM ai_calls a LEFT JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ${req.authUser.tenantId} ORDER BY a.id DESC LIMIT 100`;
    return { items: rows };
  });
}
