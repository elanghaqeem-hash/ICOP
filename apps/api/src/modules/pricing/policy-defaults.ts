/**
 * Seed parameters. Sumber: DefendIT360 BRD v2.0 (§3.1, §3.2, §8.1–8.3, E.2–E.3) dan
 * Master Development Prompt (§G2, §L1). Nilai ini adalah SEED — engine selalu membaca
 * dari tabel `policies` (versi aktif), tidak dari file ini.
 */
export const PRICING_POLICY_SEED = {
  currency: 'IDR',
  rateCard: {
    pm: { label: 'Project Manager', domestic: 1_500_000, overseas: 4_000_000 },
    lead: { label: 'Lead Pentester/Consultant', domestic: 2_000_000, overseas: 4_000_000 },
    senior: { label: 'Senior Pentester/Analyst', domestic: 1_000_000, overseas: 3_900_000 },
    junior: { label: 'Junior Pentester/Analyst', domestic: 500_000, overseas: 1_500_000 },
    forensic: { label: 'Forensic/Specialist', domestic: 2_000_000, overseas: 5_000_000 },
    soc_l1: { label: 'SOC Analyst L1', domestic: 700_000, overseas: 2_500_000 },
    soc_l2: { label: 'SOC Analyst L2', domestic: 1_200_000, overseas: 3_500_000 },
    cti: { label: 'CTI Analyst', domestic: 1_500_000, overseas: 4_000_000 },
  } as Record<string, { label: string; domestic: number; overseas: number }>,
  tierMultipliers: { S: 1.4, A: 1.0, B: 0.9, C: 2.2, D: 0.8, E: 0.8 } as Record<string, number>,
  tierRanges: { S: [1.3, 1.5], A: [1.0, 1.0], B: [0.85, 0.95], C: [2.0, 2.5], D: [0.7, 0.9], E: [0.75, 0.85] } as Record<string, [number, number]>,
  minMargin: 0.2,
  targetMargin: 0.35,
  premiumFactor: 1.25,
  marginWarning: 0.25,
  marginHold: 0.2,
  overheadPct: 0,
  contingencyPct: 0,
  taxRatePct: 11,
  documentsDefault: 2_000_000,
  dai: {
    weights: { cpi: 0.4, fx: 0.3, market: 0.2, urgency: 0.1 },
    indices: { cpi: 1.0, fx: 1.0, market: 1.0 },
    urgency: { normal: 1.0, priority: 1.1, rush: 1.25 } as Record<string, number>,
  },
  vapt: {
    webBase: { simple: 3, medium: 5, complex: 8, critical: 12 } as Record<string, number>,
    box: { black: 1.0, grey: 1.2, white: 1.5 } as Record<string, number>,
    auth: { basic: 1.0, sso: 1.1, mfa: 1.2, idam: 1.3 } as Record<string, number>,
    compliance: { owasp: 1.0, owasp_formal: 1.1, ojk: 1.2, pci: 1.3 } as Record<string, number>,
    mobileBase: { android: 4, ios: 4, dual: 7 } as Record<string, number>,
    mobileFeature: { basic: 1.0, fintech: 1.3, biometric: 1.4, offline_pki: 1.5 } as Record<string, number>,
    apiDoc: { documented: 1.0, limited: 1.2, none: 1.4 } as Record<string, number>,
    teamMix: { pm: 0.175, lead: 0.275, senior: 0.375, junior: 0.175 },
    pmMinMd: 2,
  },
  soc: {
    method: 'simplified',
    epsMedian: {
      windows_server: 100, linux_server: 50, virtual_machine: 50, workstation: 20, firewall: 200, waf: 100,
      ids_ips: 150, proxy: 50, email_gateway: 25, network_device: 15, cloud_account: 200, web_app: 30,
      database: 20, edr_unified: 100,
    } as Record<string, number>,
    simplifiedAssetTypes: ['windows_server', 'linux_server', 'virtual_machine', 'firewall', 'waf', 'ids_ips', 'proxy',
      'email_gateway', 'network_device', 'cloud_account', 'web_app', 'database', 'edr_unified'],
    burstFactor: 1.2,
    bands: [
      { maxEps: 500, monthly: 20_000_000, team: '1 analyst shared pool' },
      { maxEps: 2000, monthly: 42_500_000, team: '1-2 analyst dedicated shift' },
      { maxEps: 5000, monthly: 77_500_000, team: '2-3 analyst per shift' },
      { maxEps: 10000, monthly: 125_000_000, team: '3-4 analyst per shift' },
    ],
    coverage: { '8x5': 0.5, '16x7': 0.7, '24x7': 1.0 } as Record<string, number>,
    serviceTier: { essential: 1.0, standard: 1.2, advanced: 1.5 } as Record<string, number>,
    includedLogSources: 15,
    extraLogSourceMonthly: 1_500_000,
    edrPerEndpointMonthly: { default: 60_000, S: 120_000 } as Record<string, number>,
    onboardingFee: 37_500_000,
  },
  /** CTI/ETLM — BRD v2.0 §8.4 B–D & Lampiran A.3 */
  cti: {
    industryRisk: { banking: 3, bpd: 3, bpr_bprs: 2.5, fintech: 2.5, insurance: 2.5, multifinance: 2.5, capital_market: 2.5,
      bumn: 2, government: 2, other: 1.5 } as Record<string, number>,
    tiers: [
      { key: 'enterprise', label: 'Enterprise — Fusion', minScore: 5, monthly: [90_000_000, 150_000_000] },
      { key: 'advanced', label: 'Advanced — Threat Intel', minScore: 3.5, monthly: [50_000_000, 80_000_000] },
      { key: 'standard', label: 'Standard — Threat Monitor', minScore: 2, monthly: [25_000_000, 45_000_000] },
      { key: 'basic', label: 'Basic — Brand Watch', minScore: 0, monthly: [10_000_000, 20_000_000] },
    ],
    addons: { siemSetup: 27_500_000, apiIntegration: 15_000_000, takedown: 5_000_000, emergencyRfi: 8_000_000, dpia: 20_000_000 },
  },
  /** ISO implementation — BRD v2.0 Seksi 4 (4.1–4.7) */
  iso: {
    baseByEmployees: [{ max: 50, md: 20 }, { max: 200, md: 35 }, { max: 500, md: 50 }, { max: null as number | null, md: 70 }],
    perLocationMd: 2,
    scope: { department: 0.8, it_security: 0.9, company: 1.0, group: 1.3 } as Record<string, number>,
    maturity: { '1': 1.3, '2': 1.1, '3': 1.0, '4': 0.9 } as Record<string, number>,
    serviceType: { gap: 0.3, full: 1.0, full_audit: 1.2 } as Record<string, number>,
    additionalFrameworkFactor: 0.5, // ASUMSI: tiap framework tambahan +50% base (BRD tidak merinci)
    teamMix: { pm: 0.1, lead: 0.3, senior: 0.45, junior: 0.15 },
    pmMinMd: 2,
  },
  /** PDP / DPO as a Service — BRD v2.0 Seksi 5 */
  pdp: {
    dpoMonthly: { lt8: 15_000_000, h8_20: 35_000_000, h20_40: 60_000_000 } as Record<string, number>,
    dpiaEach: 20_000_000,
  },
};
export type PricingPolicy = typeof PRICING_POLICY_SEED;

/** DoA versi master prompt (diasumsikan = ICOP Pre-Development Decision Record v1.0). */
export const DOA_MASTER_PROMPT = {
  sequential: true,
  slaHours: { 1: 24, 2: 48, 3: 72 } as Record<string, number>,
  rules: [
    { type: 'QUOTATION_VALUE', metric: 'grandTotalExTax', bands: [{ max: 50_000_000, level: 1 }, { max: 500_000_000, level: 2 }, { max: null, level: 3 }] },
    { type: 'DISCOUNT', metric: 'discountPct', bands: [{ max: 0, level: 0 }, { max: 5, level: 1 }, { max: 15, level: 2 }, { max: null, level: 3 }] },
    { type: 'MARGIN_EXCEPTION', metric: 'marginHold', bands: [{ max: 0, level: 0 }, { max: null, level: 3 }] },
    { type: 'BELOW_FLOOR', metric: 'belowFloor', bands: [{ max: 0, level: 0 }, { max: null, level: 3 }] },
    { type: 'TENDER', metric: 'tenderValue', bands: [{ max: 1_000_000_000, level: 2 }, { max: null, level: 3 }] },
  ],
};

export const DOA_BRD_V2 = {
  sequential: true,
  slaHours: { 1: 24, 2: 48, 3: 72 } as Record<string, number>,
  rules: [
    { type: 'QUOTATION_VALUE', metric: 'grandTotalExTax', bands: [{ max: 250_000_000, level: 2 }, { max: null, level: 3 }] },
    { type: 'DISCOUNT', metric: 'discountPct', bands: [{ max: 15, level: 2 }, { max: null, level: 3 }] },
    { type: 'MARGIN_EXCEPTION', metric: 'marginHold', bands: [{ max: 0, level: 0 }, { max: null, level: 3 }] },
    { type: 'BELOW_FLOOR', metric: 'belowFloor', bands: [{ max: 0, level: 0 }, { max: null, level: 3 }] },
    { type: 'TENDER', metric: 'tenderValue', bands: [{ max: 1_000_000_000, level: 2 }, { max: null, level: 3 }] },
  ],
};
export type DoaPolicy = typeof DOA_MASTER_PROMPT;

/** DoA v3 = v2 + aturan kontrak & FlexGuard sesuai master prompt §L1 (New Contract; FlexGuard top-up/rollover). */
export const DOA_MASTER_PROMPT_V3: DoaPolicy = {
  ...DOA_MASTER_PROMPT,
  rules: [
    ...DOA_MASTER_PROMPT.rules,
    { type: 'CONTRACT_VALUE', metric: 'contractValue', bands: [{ max: 50_000_000, level: 1 }, { max: 250_000_000, level: 2 }, { max: null, level: 3 }] },
    { type: 'FLEXGUARD_VALUE', metric: 'flexguardValue', bands: [{ max: 50_000_000, level: 1 }, { max: 500_000_000, level: 2 }, { max: null, level: 3 }] },
  ],
};

/**
 * FlexGuard Token — sumber: "Desain Produk FlexGuard Token v1.0 (Juni 2026)" (project doc FlexGuard_Token.docx).
 * Dokumen menyatakan parameter harga masih harus difinalisasi bersama Finance & Management → status PENDING_OWNER_APPROVAL.
 */
export const FLEXGUARD_POLICY = {
  trv: 3_500_000,
  ladder: [
    { package: 'Starter', min: 10, max: 24, price: 3_800_000, validMonths: 6, rollover: false, bonusPct: 0 },
    { package: 'Standard', min: 25, max: 49, price: 3_300_000, validMonths: 12, rollover: false, bonusPct: 0 },
    { package: 'Professional', min: 50, max: 99, price: 2_900_000, validMonths: 12, rollover: false, bonusPct: 0 },
    { package: 'Business', min: 100, max: 249, price: 2_600_000, validMonths: 18, rollover: false, bonusPct: 3 },
    { package: 'Enterprise', min: 250, max: 499, price: 2_400_000, validMonths: 24, rollover: true, bonusPct: 5 },
    { package: 'Strategic', min: 500, max: null as number | null, price: 2_200_000, validMonths: 24, rollover: true, bonusPct: 5 },
  ],
  minTokens: 10,
  tdc: { junior: 0.5, soc_l1: 0.7, senior: 1.0, soc_l2: 1.2, pm: 1.5, cti: 1.5, lead: 2.0, forensic: 2.0, iso_lead: 2.0, dpo: 2.0, sme: 2.5 } as Record<string, number>,
  tdcRange: { sme: [2.5, 4.0] } as Record<string, [number, number]>,
  internalRate: { junior: 500_000, soc_l1: 700_000, senior: 1_000_000, soc_l2: 1_200_000, pm: 1_500_000, cti: 1_500_000, lead: 2_000_000, forensic: 2_000_000,
    iso_lead: 2_000_000, dpo: 2_000_000, sme: 3_000_000 } as Record<string, number>,
  overheadRatio: 1.0, // alokasi overhead proyek ≈ 100% biaya SDM (dokumen §5.1)
  floorMarginDivisor: 0.8, // FLOOR = cost / 0.8
  multipliers: { overseas: 2.0, rush: 1.25 },
  roundTo: 0.5,
  lowBalancePct: 20,
  cancellationMaxScopingFee: 1,
  complimentary: [
    { minExclusive: 100, item: 'Cybersecurity Awareness Session (1×, half-day, ≤50 peserta)' },
    { minInclusive: 250, item: 'Phishing Simulation (1 batch) + laporan ringkas' },
    { minInclusive: 500, item: 'Executive Security Briefing (≤2 jam)' },
  ],
  complimentaryRedeemMonths: 6,
  membership: [{ name: 'Platinum', min: 250 }, { name: 'Gold', min: 100 }, { name: 'Silver', min: 25 }],
  serviceLines: ['VAPT', 'RED_TEAM', 'IT_AUDIT', 'ISO_CONSULTING', 'SECURE_SDLC', 'SOURCE_CODE_REVIEW', 'DIGITAL_FORENSICS', 'INCIDENT_RESPONSE',
    'HARDENING', 'MATURITY_ASSESSMENT', 'THREAT_HUNTING', 'CTI_RFI', 'AWARENESS_TRAINING', 'DPO_ADVISORY'],
};
export type FlexguardPolicy = typeof FLEXGUARD_POLICY;
