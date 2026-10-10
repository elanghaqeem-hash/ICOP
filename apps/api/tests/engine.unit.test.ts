import { describe, expect, it } from 'vitest';
import { PRICING_POLICY_SEED as P, DOA_MASTER_PROMPT, DOA_BRD_V2 } from '../src/modules/pricing/policy-defaults.js';
import { PriceInput, SocInput, VaptInput, calculatePrice, redactPrice, sizeSoc, sizeVapt } from '../src/modules/pricing/engine.js';
import { evaluateDoa } from '../src/modules/approvals/engine.js';
import { redact } from '../src/modules/ai/gateway.js';

describe('VAPT sizing (BRD §8.2)', () => {
  it('web app formula: (Base + 0.5·roles + ⌈api/25⌉) × box × auth × compliance', () => {
    const r = sizeVapt(VaptInput.parse({ web: [{ name: 'Portal', complexity: 'medium', roles: 4, apiEndpoints: 60 }], webMethod: 'grey', webAuth: 'sso', compliance: 'ojk' }), P.vapt);
    // (5 + 2 + 3) × 1.2 × 1.1 × 1.2 = 15.84 → 16 (dibulatkan 0.5)
    expect(r.lines[0].md).toBe(16);
    expect(r.technicalMd).toBe(16);
    expect(r.team.lead + r.team.senior + r.team.junior).toBeCloseTo(16, 5);
    expect(r.team.pm).toBeGreaterThanOrEqual(2);
    expect(r.status).toBe('ENGINEER_REVIEW_REQUIRED');
  });
  it('financial data forces critical complexity', () => {
    const r = sizeVapt(VaptInput.parse({ web: [{ name: 'IB', complexity: 'simple', handlesFinancialData: true }] }), P.vapt);
    expect(r.flags.join(' ')).toMatch(/critical/);
    expect(r.lines[0].md).toBe(roundHalf((12 + 0.5) * 1.2));
  });
  it('network + mobile + api', () => {
    const r = sizeVapt(VaptInput.parse({
      mobile: [{ name: 'App', platform: 'dual', feature: 'fintech', includeBackend: true }],
      api: [{ name: 'Gateway', endpoints: 60, doc: 'limited' }],
      network: { externalIps: 30, internalHosts: 250, activeDirectory: true },
    }), P.vapt);
    const by = Object.fromEntries(r.lines.map((l) => [l.item, l.md]));
    expect(by['Mobile: App']).toBe(roundHalf(7 * 1.3 * 1.5));
    expect(by['API: Gateway']).toBe(roundHalf(Math.max(3, 3 * 1.5) * 1.0 * 1.2));
    expect(by['Network: External IP']).toBe(2);
    expect(by['Network: Internal host']).toBe(9);
    expect(by['Network: Active Directory']).toBe(2);
  });
  it('empty scope rejected', () => {
    expect(() => sizeVapt(VaptInput.parse({}), P.vapt)).toThrow(/kosong/);
  });
});

describe('SOC sizing (BRD §8.3)', () => {
  it('simplified method ignores workstations, applies 1.2 burst and band', () => {
    const r = sizeSoc(SocInput.parse({ assets: { windows_server: 10, firewall: 2, workstation: 500 }, logSources: 20, coverage: '24x7', serviceTier: 'essential' }), P.soc, 'A', 1.0);
    expect(r.totalEps).toBe(10 * 100 + 2 * 200);
    expect(r.effectiveEps).toBe(Math.ceil(1400 * 1.2));
    expect(r.band?.maxEps).toBe(2000);
    expect(r.lines[0].unitPrice).toBe(42_500_000);
    expect(r.lines.find((l) => l.item.startsWith('Log source'))?.unitPrice).toBe(5 * 1_500_000);
    expect(r.flags.join(' ')).toMatch(/workstation/);
  });
  it('>10k EPS requires custom pricing', () => {
    const r = sizeSoc(SocInput.parse({ assets: { cloud_account: 60 } }), P.soc, 'A', 1);
    expect(r.customRequired).toBe(true);
  });
});

describe('Price engine', () => {
  it('BPK Penabur reference case: cost 83.5jt, price 100jt → margin 16.5% → HOLD', () => {
    const r = calculatePrice(PriceInput.parse({ clientTier: 'B', hr: [{ role: 'pm', md: 7 }, { role: 'lead', md: 13 }, { role: 'senior', md: 40 }, { role: 'junior', md: 10 }],
      selectedBasis: 'manual', manualPrice: 100_000_000 }), P);
    expect(r.boq.A_humanResources.total).toBe(81_500_000);
    expect(r.boq.totalCost).toBe(83_500_000);
    expect(r.grossMarginPct).toBe(16.5);
    expect(r.markupPct).toBe(19.76);
    expect(r.flags.marginHold).toBe(true);
    expect(r.flags.belowFloor).toBe(true);
    expect(r.prices.floor).toBe(Math.round(83_500_000 / 0.8));
  });
  it('margin vs markup are distinct; standard = cost/(1-35%) × DAI × tier', () => {
    const r = calculatePrice(PriceInput.parse({ clientTier: 'S', hr: [{ role: 'senior', md: 10 }], documents: 0 }), P);
    expect(r.prices.standard).toBe(Math.round((10_000_000 / 0.65) * 1.0 * 1.4));
    expect(r.prices.premium).toBe(Math.round(r.prices.standard * 1.25));
    expect(r.grossMarginPct).not.toBe(r.markupPct);
    expect(r.taxAmount).toBe(Math.round(r.sellingPrice * 0.11));
  });
  it('overseas tier C uses overseas rate card', () => {
    const r = calculatePrice(PriceInput.parse({ clientTier: 'C', hr: [{ role: 'lead', md: 5 }] }), P);
    expect(r.delivery).toBe('overseas');
    expect(r.boq.A_humanResources.lines[0].rate).toBe(4_000_000);
  });
  it('rush urgency raises DAI (0.1 weight × 1.25)', () => {
    const r = calculatePrice(PriceInput.parse({ clientTier: 'A', hr: [{ role: 'senior', md: 5 }], urgency: 'rush' }), P);
    expect(r.dai).toBe(1.025);
  });
  it('redactPrice removes all cost & margin fields', () => {
    const r = calculatePrice(PriceInput.parse({ clientTier: 'A', hr: [{ role: 'senior', md: 5 }] }), P);
    const s = JSON.stringify(redactPrice(r));
    for (const k of ['totalCost', 'floor', 'grossMargin', 'markup', 'boq', 'rate']) expect(s).not.toContain(k);
  });
});

describe('DoA evaluation', () => {
  const m = (v: number, d = 0, hold = 0, bf = 0) => ({ grandTotalExTax: v, discountPct: d, marginHold: hold, belowFloor: bf });
  it('master prompt bands', () => {
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(40e6)).requiredLevel).toBe(1);
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(50e6)).requiredLevel).toBe(1);
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(50_000_001)).requiredLevel).toBe(2);
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(500e6)).requiredLevel).toBe(2);
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(600e6)).requiredLevel).toBe(3);
  });
  it('most stringent wins (small value, big discount)', () => {
    const e = evaluateDoa(DOA_MASTER_PROMPT, m(30e6, 20));
    expect(e.requiredLevel).toBe(3);
    expect(e.steps.map((s) => s.level)).toEqual([1, 2, 3]);
  });
  it('margin exception always director', () => {
    expect(evaluateDoa(DOA_MASTER_PROMPT, m(10e6, 0, 1)).requiredLevel).toBe(3);
  });
  it('BRD v2.0 alternative: Head Sales up to 250jt', () => {
    expect(evaluateDoa(DOA_BRD_V2, m(250e6, 10)).requiredLevel).toBe(2);
    expect(evaluateDoa(DOA_BRD_V2, m(251e6)).requiredLevel).toBe(3);
  });
});

describe('AI redaction', () => {
  it('redacts secrets, emails, NPWP, IPs, phones', () => {
    const r = redact('password: hunter2 kontak budi@bank.co.id NPWP 01.234.567.8-901.000 server 10.1.2.3/24 hp 081234567890');
    expect(r.text).not.toMatch(/hunter2|budi@|01\.234|10\.1\.2\.3|081234567890/);
    expect(r.count).toBeGreaterThanOrEqual(5);
  });
});

function roundHalf(n: number) { return Math.round(n * 2) / 2; }
