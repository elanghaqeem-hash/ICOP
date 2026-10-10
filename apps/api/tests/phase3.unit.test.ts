import { describe, expect, it } from 'vitest';
import { FLEXGUARD_POLICY as P } from '../src/modules/pricing/policy-defaults.js';
import { calculate, CalculatorInput, estimateTokens, floorCheck } from '../src/modules/flexguard/engine.js';
import { paymentSchedule } from '../src/modules/contracts/routes.js';
import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import { chunkPages, verifyQuote } from '../src/modules/documents/service.js';

describe('FlexGuard token math (dokumen produk §5.4)', () => {
  it('contoh A: VAPT 18 MD → 23 token', () => expect(estimateTokens(P, [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 7 }, { role: 'junior', md: 3 }]).tokens).toBe(23));
  it('contoh B: IT audit 10 MD → 13 token', () => expect(estimateTokens(P, [{ role: 'iso_lead', md: 4 }, { role: 'senior', md: 4 }, { role: 'junior', md: 2 }]).tokens).toBe(13));
  it('contoh C: forensik rush → 17,5 token', () => expect(estimateTokens(P, [{ role: 'forensic', md: 6 }, { role: 'senior', md: 2 }], { rush: true }).tokens).toBe(17.5));
  it('rounds up to 0.5 and applies overseas', () => {
    expect(estimateTokens(P, [{ role: 'junior', md: 1.2 }]).tokens).toBe(1);
    expect(estimateTokens(P, [{ role: 'senior', md: 3 }], { overseas: true }).tokens).toBe(6);
  });
  it('floor guard: 23 token × Rp2,6 jt ≥ floor Rp57,5 jt; × Rp1,5 jt di bawah floor', () => {
    const e = estimateTokens(P, [{ role: 'pm', md: 3 }, { role: 'lead', md: 5 }, { role: 'senior', md: 7 }, { role: 'junior', md: 3 }]);
    expect(e.floorValue).toBe(57_500_000);
    expect(floorCheck(23, 2_600_000, e.floorValue).belowFloor).toBe(false);
    expect(floorCheck(23, 1_500_000, e.floorValue).belowFloor).toBe(true);
  });
  it('ladder & complimentary thresholds', () => {
    expect(calculate(P, CalculatorInput.parse({ tokens: 100 })).complimentary).toHaveLength(0); // > 100, bukan ≥
    expect(calculate(P, CalculatorInput.parse({ tokens: 101 })).complimentary).toHaveLength(1);
    expect(calculate(P, CalculatorInput.parse({ tokens: 250 })).complimentary).toHaveLength(2);
    expect(calculate(P, CalculatorInput.parse({ tokens: 250 })).rollover).toBe(true);
    expect(calculate(P, CalculatorInput.parse({ tokens: 5 })).warnings.join()).toMatch(/Minimum/);
  });
});

describe('Contract payment schedule', () => {
  it('30/50/20 sums exactly to contract value', () => {
    const s = paymentSchedule('PROJECT', '30% DP, 50% progress, 20% BAST', 100_000_001, '2026-11-01', '2027-01-31');
    expect(s.map((x) => x.percent)).toEqual([30, 50, 20]);
    expect(s.reduce((a, x) => a + x.amount, 0)).toBe(100_000_001);
  });
  it('managed service → monthly installments', () => {
    const s = paymentSchedule('MANAGED_SERVICE', 'bulanan', 120_000_000, '2026-01-01', '2026-12-31');
    expect(s).toHaveLength(12);
    expect(s.reduce((a, x) => a + x.amount, 0)).toBe(120_000_000);
  });
  it('unparseable terms → single obligation', () => expect(paymentSchedule('PROJECT', 'sesuai kesepakatan', 50, '2026-01-01', '2026-02-01')).toHaveLength(1));
});

describe('Secrets & document helpers', () => {
  it('AES-GCM round trip and tamper detection', () => {
    const e = encryptSecret('sk-secret-value');
    expect(decryptSecret(e)).toBe('sk-secret-value');
    const parts = e.split(':'); parts[3] = Buffer.from('xxxx').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
  it('chunking & quote verification', () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ pageNo: i + 1, text: 'x'.repeat(5000) + ` halaman ${i + 1}` }));
    expect(chunkPages(pages).length).toBe(3);
    const map = new Map([[1, 'Penyedia wajib menyediakan SOC 24x7.']]);
    expect(verifyQuote('menyediakan SOC 24x7', 1, map).verified).toBe(true);
    expect(verifyQuote('menyediakan SOC 8x5', 1, map).verified).toBe(false);
  });
});
