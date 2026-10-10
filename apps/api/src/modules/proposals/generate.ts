import type { Sql, Tx } from '../../db.js';

export interface Source { type: string; ref: string; label: string }
export interface SectionDraft { key: string; title: string; titleEn: string; required: boolean; content: string; sources: Source[]; missing: string[] }

export const SECTION_DEFS: [string, string, string, boolean][] = [
  ['cover', 'Sampul', 'Cover', true],
  ['executive_summary', 'Ringkasan Eksekutif', 'Executive Summary', true],
  ['understanding', 'Pemahaman Kebutuhan', 'Understanding of Requirements', true],
  ['challenges', 'Tantangan Bisnis & Teknis', 'Business & Technical Challenges', false],
  ['proposed_solution', 'Solusi yang Diusulkan', 'Proposed Solution', true],
  ['architecture', 'Arsitektur Solusi', 'Solution Architecture', false],
  ['scope_of_work', 'Lingkup Pekerjaan', 'Scope of Work', true],
  ['service_specifications', 'Spesifikasi Layanan', 'Service Specifications', true],
  ['methodology', 'Metodologi Teknis', 'Technical Methodology', true],
  ['implementation', 'Pendekatan Implementasi', 'Implementation Approach', true],
  ['deliverables', 'Deliverables & Kriteria Penerimaan', 'Deliverables & Acceptance Criteria', true],
  ['organization', 'Organisasi Proyek', 'Project Organization', true],
  ['timeline', 'Jadwal Proyek', 'Project Timeline', true],
  ['sla_support', 'SLA & Dukungan', 'SLA & Support', false],
  ['compliance_matrix', 'Matriks Kepatuhan Teknis', 'Technical Compliance Matrix', false],
  ['security_risk', 'Keamanan & Manajemen Risiko', 'Security & Risk Management', true],
  ['assumptions', 'Asumsi, Ketergantungan & Pengecualian', 'Assumptions, Dependencies & Exclusions', true],
  ['company_capabilities', 'Kapabilitas Perusahaan', 'Company Capabilities', true],
  ['relevant_experience', 'Pengalaman Relevan', 'Relevant Experience', false],
  ['appendices', 'Lampiran', 'Appendices', false],
];

export const TODO = '[PERLU DILENGKAPI]';
const fmt = (n: number) => 'Rp ' + Math.round(n).toLocaleString('id-ID');

const METHODOLOGY: Record<string, string[]> = {
  VAPT: ['Perencanaan & Rules of Engagement — konfirmasi scope, window pengujian, kontak darurat, dan otorisasi tertulis.',
    'Reconnaissance & enumerasi — identifikasi permukaan serangan sesuai scope yang disetujui.',
    'Analisis kerentanan — kombinasi pemindaian otomatis dan verifikasi manual.',
    'Eksploitasi terkendali — pembuktian dampak tanpa mengganggu layanan produksi.',
    'Pelaporan — temuan dengan tingkat risiko, bukti, dan rekomendasi perbaikan.',
    'Retest — verifikasi perbaikan atas temuan sesuai kesepakatan.'],
  SOC: ['Onboarding — integrasi log source, baseline, dan tuning use case.', 'Monitoring & triase alert sesuai jam layanan yang disepakati.',
    'Investigasi & eskalasi insiden sesuai matriks eskalasi.', 'Pelaporan berkala dan service review.'],
  CTI: ['Profiling aset digital & brand.', 'Pemantauan sumber intelijen (surface, deep & dark web) sesuai tier.', 'Analisis, validasi, dan penyampaian alert.', 'Laporan berkala dan RFI.'],
  GRC: ['Inisiasi & gap assessment terhadap klausul standar.', 'Penyusunan kebijakan, prosedur, dan risk assessment.', 'Implementasi & pendampingan.', 'Internal audit & tinjauan manajemen.', 'Pendampingan audit sertifikasi (bila dalam scope).'],
};

/**
 * Bangun draf proposal HANYA dari data sistem (customer, opportunity, assessment, tender, katalog, company facts VERIFIED).
 * Bagian tanpa sumber diberi penanda [PERLU DILENGKAPI] + daftar missing info.
 */
export async function buildGroundedSections(db: Sql | Tx, tenantId: string, opportunityId: string, tenderId: string | null): Promise<SectionDraft[]> {
  const [o] = await db`SELECT o.*, c.legal_name, c.industry, c.city, c.existing_technologies FROM opportunities o JOIN customers c ON c.id = o.customer_id
                       WHERE o.id = ${opportunityId} AND o.tenant_id = ${tenantId}`;
  const assessments = await db`SELECT id, service_type, answers, result, status FROM assessments WHERE opportunity_id = ${opportunityId} AND tenant_id = ${tenantId} AND status = 'REVIEWED' ORDER BY created_at`;
  const unreviewed = await db`SELECT count(*)::int AS n FROM assessments WHERE opportunity_id = ${opportunityId} AND tenant_id = ${tenantId} AND status <> 'REVIEWED'`;
  const facts = await db`SELECT id, kind, title, detail FROM company_facts WHERE tenant_id = ${tenantId} AND status = 'VERIFIED' AND (valid_until IS NULL OR valid_until >= current_date) ORDER BY kind, title`;
  const reqs = tenderId ? await db`SELECT ref_code, category, requirement, mandatory, compliance_status, response FROM tender_requirements WHERE tender_id = ${tenderId} ORDER BY category, ref_code` : [];
  const [tender] = tenderId ? await db`SELECT code, title, procuring_entity, submission_deadline FROM tenders WHERE id = ${tenderId}` : [];
  const catalog = await db`SELECT sku, name, category FROM catalog_items WHERE tenant_id = ${tenantId} AND is_active`;
  const acts = await db`SELECT kind, subject, notes, created_at FROM activities WHERE opportunity_id = ${opportunityId} AND notes IS NOT NULL ORDER BY created_at DESC LIMIT 5`;

  const S = (type: string, ref: string, label: string): Source => ({ type, ref, label });
  const oppSrc = S('opportunity', o.code as string, `Opportunity ${o.code}`);
  const custSrc = S('customer', o.customerId as string, `Customer ${o.legalName}`);
  const aSrc = assessments.map((a) => S('assessment', a.id as string, `Assessment ${a.serviceType} (REVIEWED)`));
  const tSrc = tender ? [S('tender', tenderId!, `Tender ${tender.code}`)] : [];
  const services = [...new Set(assessments.map((a) => a.serviceType as string))];
  const out: SectionDraft[] = [];
  const add = (key: string, content: string, sources: Source[], missing: string[] = []) => {
    const d = SECTION_DEFS.find((s) => s[0] === key)!;
    out.push({ key, title: d[1], titleEn: d[2], required: d[3], content, sources, missing });
  };

  add('cover', `${o.name}\n\nDiajukan kepada: ${o.legalName}${tender ? `\nReferensi pengadaan: ${tender.title} (${tender.code})` : ''}\nDisusun oleh: PT Data Enkripsi Informasi Teknologi (DefendIT360)\n\nDokumen ini bersifat RAHASIA dan hanya untuk keperluan evaluasi ${o.legalName}.`, [oppSrc, custSrc, ...tSrc]);

  const scopeLines: string[] = [];
  const missingScope: string[] = [];
  for (const a of assessments) {
    const r = a.result as Record<string, any>;
    if (a.serviceType === 'VAPT') for (const l of r.lines ?? []) scopeLines.push(`- ${l.item} — estimasi ${l.md} man-day`);
    if (a.serviceType === 'SOC') {
      for (const b of r.breakdown ?? []) scopeLines.push(`- Monitoring ${b.count} ${String(b.assetType).replace(/_/g, ' ')} (estimasi ${b.eps} EPS)`);
      scopeLines.push(`- Layanan ${(a.answers as any).serviceTier ?? ''} ${(a.answers as any).coverage ?? ''}; estimasi efektif ${r.effectiveEps} EPS${(a.answers as any).siemPlatform ? `; platform SIEM ${(a.answers as any).siemPlatform}` : ''}`);
    }
    if (a.serviceType === 'CTI') scopeLines.push(`- CTI/ETLM tier ${r.tier?.label}; skor risiko industri ${r.industryRisk}, footprint ${r.footprintScore}`);
    if (a.serviceType === 'GRC') { for (const l of r.lines ?? []) scopeLines.push(`- ${l.item} — estimasi ${l.md} man-day`); for (const l of r.pdpLines ?? []) scopeLines.push(`- ${l.item}`); }
  }
  if (!assessments.length) missingScope.push('Belum ada scoping assessment berstatus REVIEWED untuk opportunity ini');
  if (unreviewed[0].n) missingScope.push(`${unreviewed[0].n} assessment belum direview engineer — tidak dipakai`);

  const svcLabel = services.length ? services.join(', ') : String(o.serviceCategory).replace(/_/g, ' ');
  add('executive_summary', `DefendIT360 mengajukan proposal layanan ${svcLabel} untuk ${o.legalName}${tender ? ` sebagai tanggapan atas pengadaan "${tender.title}"` : ''}.\n\nRuang lingkup utama:\n${scopeLines.slice(0, 6).join('\n') || TODO}\n\n${TODO} — sampaikan nilai bisnis utama bagi ${o.legalName} berdasarkan hasil discovery.`,
    [oppSrc, custSrc, ...aSrc, ...tSrc], [...missingScope, 'Nilai bisnis/manfaat spesifik customer dari hasil discovery']);

  const tech = reqs.filter((r) => r.category === 'TECHNICAL');
  add('understanding', tech.length
    ? `Berdasarkan dokumen ${tender?.code ?? 'pengadaan'}, kebutuhan teknis utama ${o.legalName} meliputi:\n${tech.slice(0, 15).map((r) => `- [${r.refCode}] ${r.requirement}`).join('\n')}`
    : `${TODO} — uraikan pemahaman atas kebutuhan ${o.legalName} (industri: ${o.industry}).${acts.length ? '\n\nCatatan discovery internal:\n' + acts.map((a) => `- ${a.subject}`).join('\n') : ''}`,
    tech.length ? tSrc : [oppSrc, custSrc], tech.length ? [] : ['Pernyataan kebutuhan customer (RKS/KAK atau notulen discovery)']);

  add('challenges', `${TODO} — tantangan bisnis & teknis yang diidentifikasi bersama ${o.legalName}.${(o.existingTechnologies as string[])?.length ? `\n\nTeknologi eksisting tercatat: ${(o.existingTechnologies as string[]).join(', ')}.` : ''}`,
    [custSrc], ['Tantangan spesifik customer (hasil discovery / RKS)']);

  const cat = catalog.filter((c) => services.some((s) => (c.category as string).toUpperCase().includes(s === 'SOC' ? 'SOC' : s === 'GRC' ? 'ISO' : s)) || (c.category as string).toUpperCase().includes(String(o.serviceCategory).split('_')[0]));
  add('proposed_solution', `Solusi yang diusulkan terdiri atas komponen berikut:\n${cat.map((c) => `- ${c.name} (${c.sku})`).join('\n') || TODO}\n\nRincian lingkup mengikuti hasil scoping assessment pada bagian Lingkup Pekerjaan.`,
    [...cat.map((c) => S('catalog', c.sku as string, c.name as string)), ...aSrc], cat.length ? [] : ['Pemetaan layanan katalog untuk solusi ini']);

  const soc = assessments.find((a) => a.serviceType === 'SOC');
  add('architecture', soc ? `Arsitektur layanan SOC: log dari ${((soc.result as any).breakdown ?? []).length} kelompok aset dikirim ke ${(soc.answers as any).siemPlatform || 'platform SIEM ' + TODO} melalui kolektor; retensi log ${(soc.answers as any).retentionDays ?? TODO} hari.\n\n${TODO} — sisipkan diagram arsitektur yang disetujui Solution Architect.`
    : `${TODO} — diagram & uraian arsitektur solusi (wajib disetujui Solution Architect).`, soc ? [S('assessment', soc.id as string, 'Assessment SOC')] : [], ['Diagram arsitektur yang disetujui']);

  add('scope_of_work', scopeLines.length ? `Lingkup pekerjaan (berdasarkan scoping yang telah direview engineer):\n${scopeLines.join('\n')}` : TODO, aSrc, missingScope);

  const specs: string[] = [];
  for (const a of assessments) {
    const ans = a.answers as any;
    if (a.serviceType === 'VAPT') specs.push(`- VAPT: metodologi ${ans.webMethod ?? '-'} box, autentikasi ${ans.webAuth ?? '-'}, standar pelaporan ${ans.reportingStandard ?? ans.compliance ?? '-'}, lokasi kerja ${ans.workLocation ?? '-'}, window ${ans.assessmentWindow || TODO}`);
    if (a.serviceType === 'SOC') specs.push(`- SOC: jam layanan ${ans.coverage}, tier ${ans.serviceTier}, ${ans.logSources ?? 0} log source, retensi ${ans.retentionDays ?? '-'} hari, durasi ${ans.contractMonths} bulan`);
    if (a.serviceType === 'CTI') specs.push(`- CTI: ${(a.result as any).tier?.label}, ${ans.domains} domain, ${ans.rfiPerMonth ?? 0} RFI/bulan${ans.darkWebMonitoring ? ', dark web monitoring' : ''}`);
    if (a.serviceType === 'GRC' && ans.iso) specs.push(`- ISO: ${ans.iso.frameworks.join(', ')}, ${ans.iso.employees} karyawan, ${ans.iso.locations} lokasi, scope ${ans.iso.scope}, layanan ${ans.iso.serviceType}`);
  }
  add('service_specifications', specs.join('\n') || TODO, aSrc, specs.length ? [] : ['Spesifikasi layanan dari scoping']);

  const meth = services.flatMap((s) => [`${s}:`, ...(METHODOLOGY[s] ?? []).map((m, i) => `${i + 1}. ${m}`), '']);
  add('methodology', meth.length ? meth.join('\n').trim() : TODO, [S('template', 'methodology-v1', 'Template metodologi internal ICOP'), ...aSrc], meth.length ? [] : ['Metodologi sesuai layanan']);

  const teams = assessments.filter((a) => (a.result as any).team).map((a) => ({ s: a.serviceType, t: (a.result as any).team, md: (a.result as any).totalMd, tech: (a.result as any).technicalMd }));
  add('implementation', teams.length ? teams.map((x) => `${x.s}: total ${x.md} man-day (PM ${x.t.pm}, Lead ${x.t.lead}, Senior ${x.t.senior}, Junior ${x.t.junior}). Tahapan: kick-off → pelaksanaan → pelaporan → retest/penutupan → BAST.`).join('\n')
    : (soc ? 'SOC: onboarding → hypercare 30 hari → operasi rutin → service review bulanan.' : TODO), aSrc);

  const deliv: string[] = [];
  if (services.includes('VAPT')) deliv.push('- Laporan pendahuluan (draft) VAPT', '- Laporan akhir VAPT beserta rekomendasi', '- Laporan retest', '- Kriteria penerimaan: laporan akhir diterima & BAST ditandatangani');
  if (services.includes('SOC')) deliv.push('- Laporan onboarding & daftar use case', '- Laporan bulanan SOC', '- Laporan insiden (per kejadian)', '- Kriteria penerimaan: berita acara onboarding & service review');
  if (services.includes('CTI')) deliv.push('- Laporan intelijen berkala sesuai tier', '- Alert & takedown report');
  if (services.includes('GRC')) deliv.push('- Gap assessment report', '- Dokumen kebijakan & prosedur', '- Laporan internal audit');
  add('deliverables', deliv.join('\n') || TODO, [S('template', 'deliverables-v1', 'Template deliverable per layanan'), ...aSrc]);

  const personnel = facts.filter((f) => f.kind === 'PERSONNEL');
  add('organization', `Struktur tim: Project Manager, Lead Consultant/Pentester, Senior, dan Junior sesuai komposisi pada Pendekatan Implementasi.\n\n${personnel.length ? personnel.map((p) => `- ${p.title}: ${p.detail}`).join('\n') : `${TODO} — nama & CV tenaga ahli yang ditugaskan.`}`,
    personnel.map((p) => S('company_fact', p.id as string, p.title as string)), personnel.length ? [] : ['Nama, peran, dan CV tenaga ahli (company facts PERSONNEL terverifikasi)']);

  const weeks = teams.length ? Math.max(...teams.map((x) => Math.ceil((x.tech ?? x.md) / 10) + 1)) : null;
  add('timeline', weeks ? `Estimasi durasi pelaksanaan ±${weeks} minggu sejak kick-off (asumsi 2 personel teknis paralel, 5 hari kerja/minggu, termasuk 1 minggu pelaporan). Jadwal rinci disepakati saat kick-off.${tender?.submissionDeadline ? `\nBatas submission tender: ${new Date(tender.submissionDeadline as string).toLocaleDateString('id-ID')}.` : ''}`
    : (soc ? 'Onboarding 4–6 minggu, dilanjutkan operasi sesuai durasi kontrak.' : TODO), aSrc, weeks || soc ? [] : ['Estimasi jadwal']);

  add('sla_support', soc ? `${TODO} — SLA respons per prioritas insiden (P1–P4) sesuai kebijakan layanan yang disahkan.` : 'Dukungan selama pelaksanaan melalui PM yang ditunjuk; masa dukungan pasca-proyek sesuai kontrak.',
    soc ? [S('assessment', soc.id as string, 'Assessment SOC')] : [], soc ? ['Tabel SLA per prioritas (kebijakan layanan resmi)'] : []);

  add('compliance_matrix', reqs.length
    ? `| Ref | Kategori | Persyaratan | Status | Tanggapan |\n|---|---|---|---|---|\n${reqs.map((r) => `| ${r.refCode} | ${r.category} | ${String(r.requirement).replace(/\|/g, '/')} | ${r.complianceStatus} | ${String(r.response ?? '').replace(/\|/g, '/')} |`).join('\n')}`
    : 'Tidak ada dokumen RKS/KAK yang terhubung dengan proposal ini.', tSrc, reqs.some((r) => r.complianceStatus === 'UNREVIEWED') ? ['Sebagian persyaratan belum direview di Tender Center'] : []);

  const highRisk = reqs.filter((r) => r.mandatory && ['NON_COMPLY', 'PARTIAL', 'CLARIFY'].includes(r.complianceStatus as string));
  add('security_risk', `Seluruh data pelanggan diperlakukan sebagai informasi rahasia: akses berbasis need-to-know, penyimpanan terenkripsi, dan penghapusan data uji setelah proyek sesuai kesepakatan NDA.${highRisk.length ? `\n\nRisiko kepatuhan yang perlu dimitigasi:\n${highRisk.map((r) => `- [${r.refCode}] ${r.complianceStatus}: ${r.requirement}`).join('\n')}` : ''}`,
    [S('template', 'security-handling-v1', 'Template penanganan data'), ...tSrc]);

  const flags = assessments.flatMap((a) => ((a.result as any).flags ?? []) as string[]);
  add('assumptions', ['Asumsi:', '- Customer menyediakan akses, akun uji, dan PIC sesuai jadwal.', '- Scope sesuai hasil scoping; perubahan scope melalui change request.',
    ...flags.map((f) => `- ${f}`), '', 'Pengecualian:', '- Perbaikan (remediasi) temuan oleh tim customer kecuali dinyatakan lain.', '- Perangkat keras/lisensi yang tidak tercantum di penawaran.'].join('\n'),
    [S('template', 'assumptions-v1', 'Template asumsi'), ...aSrc]);

  const capFacts = facts.filter((f) => ['PROFILE', 'CERTIFICATION', 'ACCREDITATION', 'VENDOR_AUTHORIZATION', 'METHODOLOGY'].includes(f.kind as string));
  add('company_capabilities', capFacts.length ? capFacts.map((f) => `- ${f.title}: ${f.detail}`).join('\n') : TODO,
    capFacts.map((f) => S('company_fact', f.id as string, f.title as string)), capFacts.length ? [] : ['Company facts terverifikasi (profil, sertifikasi, akreditasi)']);

  const refs = facts.filter((f) => f.kind === 'PROJECT_REFERENCE');
  add('relevant_experience', refs.length ? refs.map((f) => `- ${f.title}: ${f.detail}`).join('\n') : `${TODO} — hanya referensi proyek yang sudah diverifikasi Legal.`,
    refs.map((f) => S('company_fact', f.id as string, f.title as string)), refs.length ? [] : ['Referensi proyek terverifikasi (company facts PROJECT_REFERENCE)']);

  add('appendices', ['- Lampiran A: Matriks kepatuhan (ekspor CSV dari Tender Center)', '- Lampiran B: CV tenaga ahli', '- Lampiran C: Dokumen legal perusahaan (sesuai daftar periksa pengemasan)'].join('\n'), tSrc);
  return out;
}

/* ───────────────────────── Claim guard (anti-fabrikasi) ───────────────────────── */

const CLAIM_PATTERNS: RegExp[] = [
  /\biso\s*\/?\s*(?:iec\s*)?\d{4,5}(?::\d{4})?/gi, /\bsoc\s*2\b/gi, /\bpci[- ]?dss\b/gi,
  /\b(cissp|cisa|cism|crisc|oscp|osce|oswe|ceh|crest|gpen|gcih|chfi|ecsa|lpt|comptia\s+\w+|ccna|ccnp|ccie|pmp)\b/gi,
  /\b(bersertifikat|tersertifikasi|certified|accredited|terakreditasi|whitelist(?:ed)?|terdaftar di bssn)\b[^.\n]{0,60}/gi,
  /\b(partner resmi|authori[sz]ed partner|gold partner|platinum partner|premier partner|mitra resmi)\b[^.\n]{0,40}/gi,
  /\b(berpengalaman|pengalaman)\s+(lebih dari\s+)?\d+\s*(\+\s*)?tahun/gi,
  /\b\d+\s*\+?\s*(klien|client|pelanggan|proyek|project|bank)\b/gi,
  /\bnomor\s+(sertifikat|registrasi)\s*[:\-]?\s*\S+/gi,
];
const squash = (s: string) => s.toLowerCase().replace(/\biec\b/g, '').replace(/[^a-z0-9]/g, '');

const STOP = new Set(['dan', 'di', 'yang', 'dengan', 'untuk', 'sebagai', 'dari', 'ke', 'oleh', 'pada', 'kami', 'kita', 'adalah', 'telah', 'sudah', 'juga', 'serta',
  'the', 'and', 'of', 'as', 'an', 'is', 'are', 'our', 'we', 'by', 'with', 'for', 'in', 'on', 'a', 'sejak', 'lebih', 'dalam', 'atau', 'para']);
const tokens = (s: string) => s.toLowerCase().replace(/\biec\b/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w) && (w.length >= 3 || /\d/.test(w)));

/**
 * Kembalikan klaim yang tidak didukung oleh konteks yang diizinkan (fakta VERIFIED + data input).
 * Klaim pendek (kode sertifikasi/standar) dicocokkan utuh; klaim frasa didukung hanya bila SEMUA token pentingnya ada di konteks.
 */
export function unsupportedClaims(text: string, allowedContext: string): string[] {
  const ctx = squash(allowedContext);
  const ctxWords = new Set(tokens(allowedContext));
  const out = new Set<string>();
  CLAIM_PATTERNS.forEach((re, idx) => {
    for (const m of text.matchAll(re)) {
      let core = m[0];
      const next = text[(m.index ?? 0) + core.length];
      if (next && /[a-z0-9]/i.test(next)) core = core.replace(/[a-z0-9]+$/i, ''); // buang kata terpotong batas regex
      core = core.trim();
      const short = idx <= 3;
      const supported = short ? ctx.includes(squash(core)) : tokens(core).every((w) => ctxWords.has(w));
      if (!supported) out.add(core.slice(0, 80));
    }
  });
  return [...out];
}

export async function allowedContextFor(db: Sql | Tx, tenantId: string, sections: { content: string; sources: Source[] }[], tenderId: string | null) {
  const facts = await db`SELECT title, detail FROM company_facts WHERE tenant_id = ${tenantId} AND status = 'VERIFIED'`;
  const reqs = tenderId ? await db`SELECT requirement FROM tender_requirements WHERE tender_id = ${tenderId}` : [];
  const cat = await db`SELECT name FROM catalog_items WHERE tenant_id = ${tenantId}`;
  return [...facts.map((f) => `${f.title} ${f.detail}`), ...reqs.map((r) => r.requirement as string), ...cat.map((c) => c.name as string),
    ...sections.flatMap((s) => s.sources.map((x) => x.label))].join('\n');
}

/* ───────────────────────── Line diff (LCS) ───────────────────────── */

export function lineDiff(a: string, b: string) {
  const A = a.split('\n'); const B = b.split('\n');
  const n = A.length; const m = B.length;
  if (n * m > 400_000) return [{ op: 'replace' as const, from: a, to: b }];
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { op: 'eq' | 'del' | 'add'; line: string }[] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ op: 'eq', line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: 'del', line: A[i++] });
    else ops.push({ op: 'add', line: B[j++] });
  }
  while (i < n) ops.push({ op: 'del', line: A[i++] });
  while (j < m) ops.push({ op: 'add', line: B[j++] });
  return ops.filter((o) => o.op !== 'eq');
}

export const fmtIdr = fmt;
