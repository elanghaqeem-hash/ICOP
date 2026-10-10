import { z } from 'zod';
import type { PricingPolicy } from './policy-defaults.js';

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const roundHalf = (n: number) => Math.round(n * 2) / 2;
const pick = (table: Record<string, number>, key: string, what: string) => {
  const v = table[key];
  if (v === undefined) throw new Error(`Nilai ${what} '${key}' tidak dikenal`);
  return v;
};

/* ───────────────────────── VAPT sizing ───────────────────────── */

export const VaptInput = z.object({
  web: z.array(z.object({
    name: z.string().min(1),
    complexity: z.enum(['simple', 'medium', 'complex', 'critical']),
    roles: z.number().int().min(1).default(1),
    apiEndpoints: z.number().int().min(0).default(0),
    handlesFinancialData: z.boolean().default(false),
  })).default([]),
  webMethod: z.enum(['black', 'grey', 'white']).default('grey'),
  webAuth: z.enum(['basic', 'sso', 'mfa', 'idam']).default('basic'),
  compliance: z.enum(['owasp', 'owasp_formal', 'ojk', 'pci']).default('owasp'),
  mobile: z.array(z.object({
    name: z.string().min(1),
    platform: z.enum(['android', 'ios', 'dual']),
    feature: z.enum(['basic', 'fintech', 'biometric', 'offline_pki']).default('basic'),
    includeBackend: z.boolean().default(false),
  })).default([]),
  api: z.array(z.object({
    name: z.string().min(1),
    endpoints: z.number().int().min(1),
    auth: z.enum(['basic', 'sso', 'mfa', 'idam']).default('basic'),
    doc: z.enum(['documented', 'limited', 'none']).default('documented'),
  })).default([]),
  network: z.object({
    externalIps: z.number().int().min(0).default(0),
    internalHosts: z.number().int().min(0).default(0),
    activeDirectory: z.boolean().default(false),
    wifiClusters: z.number().int().min(0).default(0),
    firewallPolicies: z.number().int().min(0).default(0),
    cloudAccounts: z.number().int().min(0).default(0),
  }).default({}),
  includeJunior: z.boolean().default(true),
  retestIncluded: z.boolean().default(true),
});
export type VaptInput = z.infer<typeof VaptInput>;

export interface SizingLine { item: string; md: number; formula: string }

export function sizeVapt(input: VaptInput, p: PricingPolicy['vapt']) {
  const lines: SizingLine[] = [];
  const flags: string[] = [];
  const box = pick(p.box, input.webMethod, 'box');
  const auth = pick(p.auth, input.webAuth, 'auth');
  const comp = pick(p.compliance, input.compliance, 'compliance');
  for (const w of input.web) {
    const complexity = w.handlesFinancialData && w.complexity !== 'critical' ? 'critical' : w.complexity;
    if (complexity !== w.complexity) flags.push(`${w.name}: memproses data keuangan → kompleksitas dinaikkan ke critical (BRD 1A)`);
    const base = pick(p.webBase, complexity, 'complexity');
    const raw = base + 0.5 * w.roles + Math.ceil(w.apiEndpoints / 25) * 1.0;
    const md = roundHalf(raw * box * auth * comp);
    lines.push({ item: `Web: ${w.name}`, md, formula: `(${base} + 0.5×${w.roles} + ⌈${w.apiEndpoints}/25⌉) × ${box} × ${auth} × ${comp}` });
  }
  for (const m of input.mobile) {
    const base = pick(p.mobileBase, m.platform, 'platform');
    const f = pick(p.mobileFeature, m.feature, 'feature');
    const be = m.includeBackend ? 1.5 : 1.0;
    lines.push({ item: `Mobile: ${m.name}`, md: roundHalf(base * f * be), formula: `${base} × ${f} × ${be}` });
  }
  for (const a of input.api) {
    const au = pick(p.auth, a.auth, 'auth');
    const doc = pick(p.apiDoc, a.doc, 'doc');
    const raw = Math.max(3, Math.ceil(a.endpoints / 25) * 1.5);
    if (a.endpoints > 100) flags.push(`API ${a.name}: >100 endpoint → BRD mensyaratkan custom scoping`);
    lines.push({ item: `API: ${a.name}`, md: roundHalf(raw * au * doc), formula: `max(3, ⌈${a.endpoints}/25⌉×1.5) × ${au} × ${doc}` });
  }
  const n = input.network;
  const netParts: [string, number, string][] = [
    ['External IP', Math.ceil(n.externalIps / 50) * 2, `⌈${n.externalIps}/50⌉×2`],
    ['Internal host', Math.ceil(n.internalHosts / 100) * 3, `⌈${n.internalHosts}/100⌉×3`],
    ['Active Directory', n.activeDirectory ? 2 : 0, 'AD +2'],
    ['Wi-Fi', n.wifiClusters * 2, `${n.wifiClusters}×2`],
    ['Firewall policy review', n.firewallPolicies * 1.5, `${n.firewallPolicies}×1.5`],
    ['Cloud config review', n.cloudAccounts * 3, `${n.cloudAccounts}×3`],
  ];
  for (const [item, md, formula] of netParts) if (md > 0) lines.push({ item: `Network: ${item}`, md, formula });

  const technicalMd = round(lines.reduce((s, l) => s + l.md, 0), 1);
  if (technicalMd === 0) throw new Error('Scope VAPT kosong — isi minimal satu aset');

  const mix = p.teamMix;
  const pm = Math.max(p.pmMinMd, roundHalf(technicalMd * mix.pm));
  const lead = roundHalf(technicalMd * mix.lead);
  let junior = input.includeJunior ? roundHalf(technicalMd * mix.junior) : 0;
  let senior = roundHalf(technicalMd * mix.senior + (input.includeJunior ? 0 : technicalMd * mix.junior));
  // Sesuaikan pembulatan agar Lead+Senior+Junior = MD teknis
  const diff = roundHalf(technicalMd - (lead + senior + junior));
  senior = roundHalf(senior + diff);
  if (junior < 0) junior = 0;

  return {
    service: 'VAPT' as const,
    lines,
    technicalMd,
    team: { pm, lead, senior, junior },
    totalMd: round(pm + lead + senior + junior, 1),
    flags,
    status: 'ENGINEER_REVIEW_REQUIRED' as const,
  };
}

/* ───────────────────────── SOC sizing ───────────────────────── */

export const SocInput = z.object({
  assets: z.record(z.string(), z.number().int().min(0)),
  method: z.enum(['simplified', 'per_device']).optional(),
  logSources: z.number().int().min(0).default(0),
  coverage: z.enum(['8x5', '16x7', '24x7']).default('24x7'),
  serviceTier: z.enum(['essential', 'standard', 'advanced']).default('standard'),
  edrEndpoints: z.number().int().min(0).default(0),
  contractMonths: z.number().int().min(1).max(60).default(12),
  includeOnboarding: z.boolean().default(true),
});
export type SocInput = z.infer<typeof SocInput>;

export function sizeSoc(input: SocInput, p: PricingPolicy['soc'], clientTier: string, tierMultiplier: number) {
  const method = input.method ?? p.method;
  const flags: string[] = [];
  const breakdown: { assetType: string; count: number; epsPerUnit: number; eps: number }[] = [];
  for (const [type, count] of Object.entries(input.assets)) {
    if (!count) continue;
    if (method === 'simplified' && !p.simplifiedAssetTypes.includes(type)) {
      flags.push(`Metode simplified: aset '${type}' tidak dihitung (endpoint dicover oleh EDR terpadu)`);
      continue;
    }
    const eps = p.epsMedian[type];
    if (eps === undefined) throw new Error(`Tipe aset '${type}' tidak dikenal`);
    breakdown.push({ assetType: type, count, epsPerUnit: eps, eps: count * eps });
  }
  if (method === 'per_device') flags.push('Metode per_device cenderung overestimate EPS (pelajaran internal ~76%); validasi dengan SIEM sizing calculator vendor');
  const totalEps = breakdown.reduce((s, b) => s + b.eps, 0);
  const effectiveEps = Math.ceil(totalEps * p.burstFactor);
  const band = p.bands.find((b) => effectiveEps <= b.maxEps);
  if (!band) {
    return { service: 'SOC' as const, method, breakdown, totalEps, effectiveEps, band: null, customRequired: true,
      flags: [...flags, 'EPS > 10.000 → band custom; harga wajib disusun manual'], lines: [], monthlyTotal: 0, oneTimeTotal: 0, contractValue: 0,
      status: 'ENGINEER_REVIEW_REQUIRED' as const };
  }
  const cov = pick(p.coverage, input.coverage, 'coverage');
  const st = pick(p.serviceTier, input.serviceTier, 'serviceTier');
  const baseMonthly = round(band.monthly * cov * st * tierMultiplier);
  const lines: { item: string; unit: string; qty: number; unitPrice: number; recurring: boolean }[] = [
    { item: `Managed SOC ${input.serviceTier} ${input.coverage} (band ≤${band.maxEps} EPS, ${band.team})`, unit: 'bulan', qty: input.contractMonths, unitPrice: baseMonthly, recurring: true },
  ];
  const extraSources = Math.max(0, input.logSources - p.includedLogSources);
  if (extraSources) lines.push({ item: `Log source tambahan (${extraSources} source)`, unit: 'bulan', qty: input.contractMonths, unitPrice: extraSources * p.extraLogSourceMonthly, recurring: true });
  if (input.edrEndpoints) {
    const rate = p.edrPerEndpointMonthly[clientTier] ?? p.edrPerEndpointMonthly.default;
    lines.push({ item: `Managed EDR (${input.edrEndpoints} endpoint × Rp${rate.toLocaleString('id-ID')})`, unit: 'bulan', qty: input.contractMonths, unitPrice: input.edrEndpoints * rate, recurring: true });
  }
  if (input.includeOnboarding) lines.push({ item: 'Setup & onboarding (SIEM integration, log source setup, baseline tuning)', unit: 'paket', qty: 1, unitPrice: p.onboardingFee, recurring: false });
  const monthlyTotal = lines.filter((l) => l.recurring).reduce((s, l) => s + l.unitPrice, 0);
  const oneTimeTotal = lines.filter((l) => !l.recurring).reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return {
    service: 'SOC' as const, method, breakdown, totalEps, effectiveEps, band, customRequired: false, flags, lines,
    monthlyTotal, oneTimeTotal, contractValue: monthlyTotal * input.contractMonths + oneTimeTotal,
    status: 'ENGINEER_REVIEW_REQUIRED' as const,
  };
}

/* ───────────────────────── Price & BoQ ───────────────────────── */

export const PriceInput = z.object({
  clientTier: z.enum(['S', 'A', 'B', 'C', 'D', 'E']),
  tierMultiplierOverride: z.number().positive().optional(),
  delivery: z.enum(['domestic', 'overseas']).optional(),
  urgency: z.enum(['normal', 'priority', 'rush']).default('normal'),
  hr: z.array(z.object({ role: z.string(), md: z.number().min(0) })).default([]),
  commission: z.number().min(0).default(0),
  documents: z.number().min(0).optional(),
  thirdParty: z.number().min(0).default(0),
  travel: z.number().min(0).default(0),
  recurringCost: z.number().min(0).default(0), // biaya langganan/vendor (mis. lisensi SIEM) total kontrak
  referencePrice: z.number().min(0).optional(), // harga referensi (mis. band SOC); jika ada, Standard = max(costPlus, reference)
  addOnPrice: z.number().min(0).default(0), // harga list layanan tambahan non cost-plus (mis. DPOaaS) — ditambahkan ke Floor/Standard
  selectedBasis: z.enum(['floor', 'standard', 'premium', 'manual']).default('standard'),
  manualPrice: z.number().min(0).optional(),
  discountPct: z.number().min(0).max(99.999).default(0),
});
export type PriceInput = z.infer<typeof PriceInput>;

export function calculatePrice(input: PriceInput, policy: PricingPolicy) {
  const warnings: string[] = [];
  const delivery = input.delivery ?? (input.clientTier === 'C' ? 'overseas' : 'domestic');
  const tierMult = input.tierMultiplierOverride ?? pick(policy.tierMultipliers, input.clientTier, 'tier');
  const [lo, hi] = policy.tierRanges[input.clientTier] ?? [tierMult, tierMult];
  if (tierMult < lo || tierMult > hi) warnings.push(`Multiplier tier ${input.clientTier} = ${tierMult} di luar range kebijakan ${lo}–${hi}`);

  const hrLines = input.hr.filter((h) => h.md > 0).map((h) => {
    const r = policy.rateCard[h.role];
    if (!r) throw new Error(`Role rate card '${h.role}' tidak dikenal`);
    const rate = delivery === 'overseas' ? r.overseas : r.domestic;
    return { role: h.role, label: r.label, md: h.md, rate, amount: round(h.md * rate) };
  });
  const A = hrLines.reduce((s, l) => s + l.amount, 0);
  const B = input.commission;
  const C = input.documents ?? (hrLines.length ? policy.documentsDefault : 0);
  const D = input.thirdParty + input.recurringCost;
  const E = input.travel;
  const direct = A + B + C + D + E;
  const overhead = round(direct * policy.overheadPct);
  const contingency = round(direct * policy.contingencyPct);
  const totalCost = direct + overhead + contingency;
  if (totalCost <= 0 && input.referencePrice === undefined && !input.addOnPrice) throw new Error('Total biaya 0 — isi BoQ atau harga referensi');

  const w = policy.dai.weights;
  const urgencyIdx = pick(policy.dai.urgency, input.urgency, 'urgency');
  const dai = round(w.cpi * policy.dai.indices.cpi + w.fx * policy.dai.indices.fx + w.market * policy.dai.indices.market + w.urgency * urgencyIdx, 4);
  if (input.urgency === 'rush') warnings.push('Project rush (<2 minggu): BRD merekomendasikan Premium price');

  const addOn = round(input.addOnPrice ?? 0);
  const floor = round(totalCost / (1 - policy.minMargin)) + addOn;
  const costPlusStandard = round((totalCost / (1 - policy.targetMargin)) * dai * tierMult);
  const standard = (input.referencePrice !== undefined ? Math.max(costPlusStandard, round(input.referencePrice)) : costPlusStandard) + addOn;
  const premium = round(standard * policy.premiumFactor);

  let listPrice: number;
  switch (input.selectedBasis) {
    case 'floor': listPrice = floor; break;
    case 'premium': listPrice = premium; break;
    case 'manual':
      if (input.manualPrice === undefined) throw new Error('manualPrice wajib untuk basis manual');
      listPrice = round(input.manualPrice); break;
    default: listPrice = standard;
  }
  const discountAmount = round(listPrice * input.discountPct / 100);
  const sellingPrice = listPrice - discountAmount;
  const grossProfit = sellingPrice - totalCost;
  const grossMarginPct = sellingPrice > 0 ? round((grossProfit / sellingPrice) * 100, 2) : 0;
  const markupPct = totalCost > 0 ? round((grossProfit / totalCost) * 100, 2) : null;
  const taxAmount = round(sellingPrice * policy.taxRatePct / 100);

  const belowFloor = sellingPrice < floor;
  const marginHold = totalCost > 0 && grossMarginPct < policy.marginHold * 100;
  const marginWarn = totalCost > 0 && grossMarginPct < policy.marginWarning * 100;
  if (belowFloor) warnings.push('Harga jual di bawah Floor price — wajib approval Direktur');
  if (marginHold) warnings.push(`Gross margin ${grossMarginPct}% < ambang hold ${policy.marginHold * 100}% — finalisasi ditahan, wajib MARGIN_EXCEPTION`);
  else if (marginWarn) warnings.push(`Gross margin ${grossMarginPct}% < target minimum ${policy.marginWarning * 100}%`);

  return {
    delivery, tierMultiplier: tierMult, dai, urgencyIndex: urgencyIdx,
    boq: {
      A_humanResources: { total: A, lines: hrLines },
      B_commission: B, C_documents: C, D_thirdParty: D, E_travel: E,
      direct, overhead, contingency, totalCost,
    },
    prices: { floor, standard, premium, costPlusStandard, referencePrice: input.referencePrice ?? null },
    selectedBasis: input.selectedBasis, listPrice, discountPct: input.discountPct, discountAmount, sellingPrice,
    grossProfit, grossMarginPct, markupPct, taxRatePct: policy.taxRatePct, taxAmount, grandTotal: sellingPrice + taxAmount,
    flags: { belowFloor, marginHold, marginWarn },
    warnings,
  };
}
export type PriceResult = ReturnType<typeof calculatePrice>;

/** Hilangkan semua field biaya internal — dipakai untuk role tanpa pricing.view_cost dan customer portal. */
export function redactPrice(r: PriceResult) {
  return {
    prices: { standard: r.prices.standard, premium: r.prices.premium },
    selectedBasis: r.selectedBasis, listPrice: r.listPrice, discountPct: r.discountPct, discountAmount: r.discountAmount,
    sellingPrice: r.sellingPrice, taxRatePct: r.taxRatePct, taxAmount: r.taxAmount, grandTotal: r.grandTotal,
    warnings: r.warnings.filter((w) => !/margin|floor/i.test(w)),
  };
}

/* ───────────────────────── CTI sizing (BRD §8.4 D) ───────────────────────── */

export const CtiInput = z.object({
  industry: z.string().optional(),
  domains: z.number().int().min(0).default(1),
  subsidiaries: z.number().int().min(0).default(0),
  publicIps: z.number().int().min(0).default(0),
  darkWebMonitoring: z.boolean().default(false),
  rfiPerMonth: z.number().int().min(0).default(0),
  siemIntegration: z.boolean().default(false),
  apiIntegration: z.boolean().default(false),
  takedownsPerYear: z.number().int().min(0).default(0),
  contractMonths: z.number().int().min(1).max(60).default(12),
  pricePoint: z.enum(['low', 'mid', 'high']).default('mid'),
});
export type CtiInput = z.infer<typeof CtiInput>;

export function sizeCti(input: CtiInput, p: PricingPolicy['cti'], industry: string, tierMultiplier: number) {
  const flags: string[] = [];
  const ind = input.industry ?? industry;
  const industryRisk = p.industryRisk[ind] ?? p.industryRisk.other;
  const footprint = input.domains > 10 || input.subsidiaries > 5 || input.publicIps > 500 ? 3
    : input.domains >= 5 || input.subsidiaries >= 2 ? 2 : 1;
  const score = industryRisk + footprint;
  let tier = p.tiers.find((t) => score >= t.minScore) ?? p.tiers[p.tiers.length - 1];
  const idx = (k: string) => p.tiers.findIndex((t) => t.key === k);
  if (input.darkWebMonitoring && idx(tier.key) > idx('standard')) { tier = p.tiers[idx('standard')]; flags.push('Dark web monitoring → tier minimum Standard (BRD 3.5)'); }
  if (input.rfiPerMonth > 6 && tier.key !== 'enterprise') { tier = p.tiers[idx('enterprise')]; flags.push('RFI > 6/bulan → tier Enterprise (BRD 3.9)'); }
  const [lo, hi] = tier.monthly;
  const point = input.pricePoint === 'low' ? lo : input.pricePoint === 'high' ? hi : (lo + hi) / 2;
  const monthly = round(point * tierMultiplier);
  if (tierMultiplier !== 1) flags.push(`Harga tier CTI dikalikan client tier multiplier ×${tierMultiplier}`);
  const lines: { item: string; unit: string; qty: number; unitPrice: number; recurring: boolean }[] = [
    { item: `CTI/ETLM ${tier.label}`, unit: 'bulan', qty: input.contractMonths, unitPrice: monthly, recurring: true },
  ];
  if (input.siemIntegration) lines.push({ item: 'SIEM integration & setup', unit: 'paket', qty: 1, unitPrice: p.addons.siemSetup, recurring: false });
  if (input.apiIntegration) lines.push({ item: 'API feed custom integration', unit: 'paket', qty: 1, unitPrice: p.addons.apiIntegration, recurring: false });
  if (input.takedownsPerYear) lines.push({ item: 'Takedown service (di luar paket RFI)', unit: 'takedown', qty: Math.ceil(input.takedownsPerYear * input.contractMonths / 12), unitPrice: p.addons.takedown, recurring: false });
  const monthlyTotal = lines.filter((l) => l.recurring).reduce((s, l) => s + l.unitPrice, 0);
  const oneTimeTotal = lines.filter((l) => !l.recurring).reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return { service: 'CTI' as const, industry: ind, industryRisk, footprintScore: footprint, totalScore: score, tier, lines, flags,
    monthlyTotal, oneTimeTotal, contractValue: monthlyTotal * input.contractMonths + oneTimeTotal, status: 'ENGINEER_REVIEW_REQUIRED' as const };
}

/* ───────────────────────── GRC: ISO & PDP (BRD Seksi 4–5) ───────────────────────── */

export const GrcInput = z.object({
  iso: z.object({
    frameworks: z.array(z.enum(['iso27001', 'iso27701', 'iso9001', 'iso20000', 'iso22301'])).min(1),
    employees: z.number().int().min(1),
    locations: z.number().int().min(1).default(1),
    scope: z.enum(['department', 'it_security', 'company', 'group']).default('company'),
    maturity: z.enum(['1', '2', '3', '4']).default('2'),
    existingIsms: z.boolean().default(false),
    serviceType: z.enum(['gap', 'full', 'full_audit']).default('full'),
  }).optional(),
  pdp: z.object({
    dpoHours: z.enum(['lt8', 'h8_20', 'h20_40', 'gt40']).optional(),
    dpiaCount: z.number().int().min(0).default(0),
    months: z.number().int().min(1).max(60).default(12),
  }).optional(),
  includeJunior: z.boolean().default(true),
}).refine((x) => x.iso || x.pdp, { message: 'Pilih minimal ISO atau PDP' });
export type GrcInput = z.infer<typeof GrcInput>;

export function sizeGrc(input: GrcInput, p: PricingPolicy['iso'], pdp: PricingPolicy['pdp']) {
  const flags: string[] = [];
  const lines: SizingLine[] = [];
  let team = { pm: 0, lead: 0, senior: 0, junior: 0 };
  let technicalMd = 0;
  if (input.iso) {
    const i = input.iso;
    const base = p.baseByEmployees.find((b) => b.max === null || i.employees <= b.max)!.md;
    const fw = 1 + (i.frameworks.length - 1) * p.additionalFrameworkFactor;
    const raw = (base * fw + i.locations * p.perLocationMd) * p.scope[i.scope] * p.maturity[i.maturity] * p.serviceType[i.serviceType];
    technicalMd = roundHalf(raw);
    lines.push({ item: `ISO ${i.frameworks.join(' + ')} — ${i.serviceType}`, md: technicalMd,
      formula: `(${base} × ${fw} + ${i.locations}×${p.perLocationMd}) × scope ${p.scope[i.scope]} × maturity ${p.maturity[i.maturity]} × layanan ${p.serviceType[i.serviceType]}` });
    if (i.frameworks.length > 1) flags.push(`ASUMSI: tiap framework tambahan +${p.additionalFrameworkFactor * 100}% base MD (BRD tidak merinci) — validasi konsultan`);
    if (i.existingIsms && i.serviceType !== 'gap') flags.push('ISMS sudah ada → pertimbangkan pendekatan GAP assessment (BRD 4.6)');
    const m = p.teamMix;
    const pm = Math.max(p.pmMinMd, roundHalf(technicalMd * m.pm));
    const lead = roundHalf(technicalMd * m.lead);
    const junior = input.includeJunior ? roundHalf(technicalMd * m.junior) : 0;
    const senior = roundHalf(technicalMd - lead - junior);
    team = { pm, lead, senior, junior };
  }
  const pdpLines: { item: string; unit: string; qty: number; unitPrice: number; recurring: boolean }[] = [];
  if (input.pdp) {
    if (input.pdp.dpoHours === 'gt40') flags.push('DPO > 40 jam/bulan → harga custom (BRD 5.4)');
    else if (input.pdp.dpoHours) pdpLines.push({ item: `DPO as a Service (${input.pdp.dpoHours.replace('lt', '<').replace('h', '').replace('_', '–')} jam/bulan)`, unit: 'bulan', qty: input.pdp.months, unitPrice: pdp.dpoMonthly[input.pdp.dpoHours], recurring: true });
    if (input.pdp.dpiaCount) pdpLines.push({ item: 'DPIA support (UU PDP)', unit: 'DPIA', qty: input.pdp.dpiaCount, unitPrice: pdp.dpiaEach, recurring: false });
  }
  const pdpValue = pdpLines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return { service: 'GRC' as const, lines, technicalMd, team, totalMd: round(team.pm + team.lead + team.senior + team.junior, 1),
    pdpLines, pdpValue, contractValue: pdpValue, flags, status: 'ENGINEER_REVIEW_REQUIRED' as const };
}

/* ───────────────────────── Scenario simulation (G4) ───────────────────────── */

export const SimulateInput = z.object({
  base: PriceInput,
  discounts: z.array(z.number().min(0).max(99)).max(8).default([0, 5, 10, 15, 20]),
  mdFactors: z.array(z.number().min(0.3).max(3)).max(6).default([0.8, 1, 1.2]),
  fxIndices: z.array(z.number().min(0.5).max(2)).max(6).default([0.9, 1, 1.1]),
  tiers: z.array(z.enum(['S', 'A', 'B', 'C', 'D', 'E'])).max(6).default([]),
  staffingMixes: z.array(z.enum(['as_is', 'senior_heavy', 'junior_heavy'])).default(['as_is', 'senior_heavy', 'junior_heavy']),
  competitorPrice: z.number().min(0).optional(),
});

export function simulate(input: z.infer<typeof SimulateInput>, policy: PricingPolicy) {
  const row = (dimension: string, value: string | number, inp: PriceInput, pol = policy) => {
    const r = calculatePrice(inp, pol);
    return { dimension, value, totalCost: r.boq.totalCost, sellingPrice: r.sellingPrice, grossMarginPct: r.grossMarginPct, markupPct: r.markupPct,
      floor: r.prices.floor, belowFloor: r.flags.belowFloor, marginHold: r.flags.marginHold,
      vsCompetitorPct: input.competitorPrice ? round(((r.sellingPrice - input.competitorPrice) / input.competitorPrice) * 100, 1) : null };
  };
  const b = input.base;
  const rows = [row('base', 'base', b)];
  for (const d of input.discounts) rows.push(row('discountPct', d, { ...b, discountPct: d }));
  for (const f of input.mdFactors) rows.push(row('effortFactor', f, { ...b, hr: b.hr.map((h) => ({ ...h, md: roundHalf(h.md * f) })) }));
  for (const fx of input.fxIndices) rows.push(row('fxIndex', fx, b, { ...policy, dai: { ...policy.dai, indices: { ...policy.dai.indices, fx } } }));
  for (const t of input.tiers) rows.push(row('clientTier', t, { ...b, clientTier: t, tierMultiplierOverride: undefined }));
  for (const mix of input.staffingMixes) {
    if (!b.hr.length || mix === 'as_is') { if (mix === 'as_is') continue; else continue; }
    const md = (r: string) => b.hr.filter((h) => h.role === r).reduce((s, h) => s + h.md, 0);
    const others = b.hr.filter((h) => !['senior', 'junior'].includes(h.role));
    const sen = md('senior'); const jun = md('junior');
    const hr = mix === 'senior_heavy' ? [...others, { role: 'senior', md: sen + jun }]
      : [...others, { role: 'senior', md: roundHalf(sen * 0.7) }, { role: 'junior', md: roundHalf(jun + sen * 0.3) }];
    rows.push(row('staffingMix', mix, { ...b, hr }));
  }
  return { rows, competitorPrice: input.competitorPrice ?? null };
}
