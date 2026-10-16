import bcrypt from 'bcryptjs';
import type { Sql } from './db.js';
import { DOA_BRD_V2, DOA_MASTER_PROMPT, DOA_MASTER_PROMPT_V3, FLEXGUARD_POLICY, PRICING_POLICY_SEED } from './modules/pricing/policy-defaults.js';
import { defaultProviderRows } from './modules/ai/gateway.js';

export const SEED_USERS: [string, string, string][] = [
  ['goehbudiarto@gmail.com', 'System Administrator', 'super_admin'],
  ['companyadmin@defendit360.com', 'Company Admin', 'company_admin'],
  ['direktur@defendit360.com', 'Direktur Utama', 'director'],
  ['vp@defendit360.com', 'VP Cybersecurity Strategic', 'vp_head'],
  ['salesmanager@defendit360.com', 'Sales Manager', 'sales_manager'],
  ['sales@defendit360.com', 'Account Manager', 'account_manager'],
  ['presales@defendit360.com', 'Pre-Sales Engineer', 'presales_engineer'],
  ['architect@defendit360.com', 'Solution Architect', 'solution_architect'],
  ['finance@defendit360.com', 'Pricing & Finance', 'pricing_finance'],
  ['legal@defendit360.com', 'Legal Officer', 'legal'],
  ['tender@defendit360.com', 'Tender Officer', 'tender_officer'],
  ['pm@defendit360.com', 'Project Manager', 'project_manager'],
  ['product@defendit360.com', 'Product Manager', 'product_manager'],
  ['auditor@defendit360.com', 'Internal Auditor', 'auditor'],
];

const CATALOG: [string, string, string, string, string, string, string][] = [
  // sku, type, pillar, category, name, pricing_structure, unit
  ['SVC-VAPT-WEB', 'service', 'Security Check-Up', 'VAPT', 'VAPT Web Application', 'man_day', 'MD'],
  ['SVC-VAPT-MOB', 'service', 'Security Check-Up', 'VAPT', 'VAPT Mobile Application', 'man_day', 'MD'],
  ['SVC-VAPT-API', 'service', 'Security Check-Up', 'VAPT', 'VAPT API / Web Service', 'man_day', 'MD'],
  ['SVC-VAPT-NET', 'service', 'Security Check-Up', 'VAPT', 'VAPT Network & Infrastructure', 'man_day', 'MD'],
  ['SVC-REDTEAM', 'service', 'Security Check-Up', 'Red Team/Adversarial Attack', 'Red Team Exercise', 'fixed_fee', 'paket'],
  ['SVC-SECRATING', 'service', 'Security Check-Up', 'CTI', 'Security Rating', 'annual', 'tahun'],
  ['SVC-ETLM', 'service', 'Security Check-Up', 'CTI', 'External Threat Landscape Management (ETLM)', 'annual', 'tahun'],
  ['SVC-SOC-MDR', 'service', 'Security Assistant', 'SOC/MDR', 'Managed SOC / MDR 24x7', 'monthly', 'bulan'],
  ['SVC-SOC-ONB', 'service', 'Security Assistant', 'SOC/MDR', 'SOC Setup & Onboarding', 'one_time', 'paket'],
  ['SVC-MEDR', 'service', 'Security Assistant', 'SOC/MDR', 'Managed EDR', 'per_endpoint', 'endpoint/bulan'],
  ['SVC-IR-RET', 'service', 'Security Assistant', 'DFIR', 'Incident Response Retainer', 'retainer', 'bulan'],
  ['SVC-GRC-ISO', 'service', 'Security Treatment', 'ISO Consultancy', 'ISO/IEC 27001 Implementation', 'man_day', 'MD'],
  ['SVC-GRC-PDP', 'service', 'Security Treatment', 'Privacy/PDP', 'PDP Assessment & DPO as a Service', 'monthly', 'bulan'],
  ['SVC-AWARE', 'service', 'Security Treatment', 'Cybersecurity Awareness', 'Security Awareness Training', 'fixed_fee', 'kelas'],
  ['SVC-FLEXGUARD', 'service', 'Security Treatment', 'Professional Services', 'FlexGuard Man-Day Token Wallet', 'token_wallet', 'token'],
];

export async function seed(sql: Sql, opts: { password?: string; demo?: boolean } = {}) {
  const password = opts.password ?? process.env.SEED_PASSWORD;
  if (!password) throw new Error('SEED_PASSWORD wajib diisi; tidak ada password bawaan untuk akun seed');
  if (process.env.NODE_ENV === 'production' && (password.length < 16 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password))) {
    throw new Error('SEED_PASSWORD produksi wajib minimal 16 karakter dengan huruf besar/kecil, angka, dan simbol');
  }
  const hash = await bcrypt.hash(password, 10);
  const [tenant] = await sql`INSERT INTO tenants (code, name) VALUES ('DEIT', 'PT Data Enkripsi Informasi Teknologi (DefendIT360)')
                             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  const t = tenant.id as string;
  for (const [email, name, role] of SEED_USERS) {
    await sql`INSERT INTO users (tenant_id, email, full_name, password_hash, role) VALUES (${t}, ${email}, ${name}, ${hash}, ${role})
              ON CONFLICT (tenant_id, lower(email)) DO NOTHING`;
  }
  const [admin] = await sql`SELECT id FROM users WHERE tenant_id = ${t} AND email = 'goehbudiarto@gmail.com'`;

  await ensurePolicies(sql, t, admin.id as string);
  for (const [sku, type, pillar, category, name, ps, unit] of CATALOG) {
    await sql`INSERT INTO catalog_items (tenant_id, sku, item_type, pillar, category, name, pricing_structure, unit)
              VALUES (${t}, ${sku}, ${type}, ${pillar}, ${category}, ${name}, ${ps}, ${unit}) ON CONFLICT (tenant_id, sku) DO NOTHING`;
  }
  for (const p of defaultProviderRows()) {
    await sql`INSERT INTO ai_providers (tenant_id, provider, model, priority, enabled, api_key_env, base_url, timeout_ms)
              VALUES (${t}, ${p.provider}, ${p.model}, ${p.priority}, ${p.provider !== 'custom'}, ${p.apiKeyEnv}, ${p.baseUrl}, ${p.timeoutMs})
              ON CONFLICT (tenant_id, provider) DO NOTHING`;
  }
  const [hasFacts] = await sql`SELECT 1 FROM company_facts WHERE tenant_id = ${t} LIMIT 1`;
  if (!hasFacts) {
    // Fakta dari dokumen resmi perusahaan (COMPRO DEFENDIT NEW1.PDF). Klaim akreditasi menunggu bukti surat → UNVERIFIED.
    await sql`INSERT INTO company_facts (tenant_id, kind, title, detail, status, evidence_ref, created_by, verified_at) VALUES
      (${t}, 'PROFILE', 'Badan usaha', 'PT Data Enkripsi Informasi Teknologi (DefendIT360), member of XLSMART, berkantor di Sudirman 78 Building Tower 01 Lt 27, Jakarta Pusat.', 'VERIFIED', 'COMPRO DEFENDIT NEW1.PDF', ${admin.id}, now()),
      (${t}, 'PROFILE', 'Portofolio layanan', 'Layanan dikelompokkan dalam Security Check-Up (security rating, ETLM, VAPT), Security Treatment (GRC, ISO, PDP, awareness), dan Security Assistant (SOC 24/7, MDR, incident response).', 'VERIFIED', 'COMPRO DEFENDIT NEW1.PDF', ${admin.id}, now()),
      (${t}, 'ACCREDITATION', 'Lembaga Konsultan SMPI — BSSN', 'Terdaftar (whitelisted) di BSSN sebagai Lembaga Konsultan Sistem Manajemen Pengamanan Informasi.', 'UNVERIFIED', 'COMPRO DEFENDIT NEW1.PDF — lampirkan surat/nomor registrasi BSSN', ${admin.id}, NULL)`;
  }
  console.log(`✔ seed: tenant DEIT, ${SEED_USERS.length} users (password awal wajib diganti saat login pertama)`);
  return { tenantId: t };
}

export const OWNER_APPROVAL_NOTE =
  'Disahkan owner (Teguh Budiarto, VP Cybersecurity Strategic) 2026-10-09 — menyetujui seluruh rekomendasi Phase 0. Sign-off formal Direktur di aplikasi tetap direkomendasikan.';

/**
 * Pastikan kebijakan versi terkini (PRICING-BRD2 v2, DOA-MP-2026 v2) aktif.
 * Idempoten: dipakai oleh seed dan data-migration untuk database yang sudah berjalan.
 * Versi lama tidak dihapus — di-RETIRE agar scenario/approval historis tetap dapat ditelusuri.
 */
export async function ensurePolicies(sql: Sql, tenantId: string, createdBy: string | null) {
  const targets: { kind: string; code: string; version: number; title: string; params: unknown; note: string; status?: string }[] = [
    { kind: 'PRICING', code: 'PRICING-BRD2', version: 2, title: 'Pricing Engine — BRD v2.0 reconciled (+CTI, ISO, PDP)', params: PRICING_POLICY_SEED,
      note: 'Rate card internal & formula BRD v2.0 §3, §8, Seksi 4–5; DAI master prompt §G2 (index netral 1.0); coverage SOC 8x5 ×0.5. ' },
    { kind: 'DOA', code: 'DOA-MP-2026', version: 2, title: 'DoA — Master Prompt / Decision Record v1.0 (+TENDER)', params: DOA_MASTER_PROMPT,
      note: 'Manager ≤50jt/≤5%; VP ≤500jt/≤15%; Direktur di atas; tender: VP Go/No-Go, Direktur >Rp1 M. ' },
    { kind: 'DOA', code: 'DOA-MP-2026', version: 3, title: 'DoA — Master Prompt (+TENDER, +CONTRACT, +FLEXGUARD)', params: DOA_MASTER_PROMPT_V3,
      note: 'v2 + kontrak baru (Manager ≤50jt, VP ≤250jt, Direktur di atas) & top-up/rollover FlexGuard (band nilai quotation) sesuai master prompt §L1. ' },
    { kind: 'FLEXGUARD', code: 'FLEXGUARD-PD1', version: 1, title: 'FlexGuard Token — Desain Produk v1.0', params: FLEXGUARD_POLICY, status: 'PENDING_OWNER_APPROVAL',
      note: 'TRV Rp3,5 jt, tangga volume, TDC, floor guard cost/0,8, complimentary >100 token. Dokumen produk mensyaratkan finalisasi harga bersama Finance & Management — belum disahkan. ' },
  ];
  for (const p of targets) {
    const [exists] = await sql`SELECT id FROM policies WHERE tenant_id = ${tenantId} AND code = ${p.code} AND version = ${p.version}`;
    if (exists) continue;
    await sql.begin(async (tx) => {
      await tx`UPDATE policies SET is_current = false, status = 'RETIRED' WHERE tenant_id = ${tenantId} AND kind = ${p.kind} AND is_current`;
      await tx`UPDATE policies SET status = 'RETIRED' WHERE tenant_id = ${tenantId} AND code = ${p.code} AND status <> 'RETIRED'`;
      const pending = (p as { status?: string }).status === 'PENDING_OWNER_APPROVAL';
      await tx`INSERT INTO policies (tenant_id, kind, code, version, title, params, status, is_current, effective_from, source_note, created_by, approved_at)
        VALUES (${tenantId}, ${p.kind}, ${p.code}, ${p.version}, ${p.title}, ${tx.json(p.params as never)}, ${pending ? 'PENDING_OWNER_APPROVAL' : 'ACTIVE'}, true, '2026-10-10',
                ${p.note + (pending ? 'Menunggu pengesahan owner.' : OWNER_APPROVAL_NOTE)}, ${createdBy}, ${pending ? null : sql`now()`})`;
    });
  }
  const [alt] = await sql`SELECT 1 FROM policies WHERE tenant_id = ${tenantId} AND code = 'DOA-BRD-2.0'`;
  if (!alt) {
    await sql`INSERT INTO policies (tenant_id, kind, code, version, title, params, status, is_current, effective_from, source_note, created_by)
      VALUES (${tenantId}, 'DOA', 'DOA-BRD-2.0', 1, 'DoA — BRD v2.0 Lampiran E.2 (alternatif, tidak dipilih)', ${sql.json(DOA_BRD_V2 as never)}, 'DRAFT', false, '2026-05-01',
              'Head Sales ≤250jt/≤15%; Direktur di atas. Owner memilih DOA-MP-2026 pada 2026-10-09.', ${createdBy})`;
  }
}
