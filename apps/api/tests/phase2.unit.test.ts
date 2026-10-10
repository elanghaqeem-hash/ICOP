import { describe, expect, it } from 'vitest';
import { BID_CRITERIA, scoreBid } from '../src/modules/tenders/service.js';
import { ruleExtract, scoreRelevance, verifyAiRequirements } from '../src/modules/tenders/extract.js';
import { unsupportedClaims, lineDiff } from '../src/modules/proposals/generate.js';
import { sizeCti, CtiInput } from '../src/modules/pricing/engine.js';
import { PRICING_POLICY_SEED as P } from '../src/modules/pricing/policy-defaults.js';

const all = (s: number) => Object.fromEntries(BID_CRITERIA.map((c) => [c.key, { score: s }]));

describe('Bid/No-Bid scorecard', () => {
  it('weights sum to 100 and map 1..5 to 0..100', () => {
    expect(BID_CRITERIA.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(scoreBid({ scores: all(5), conflictOfInterest: false }).weighted).toBe(100);
    expect(scoreBid({ scores: all(1), conflictOfInterest: false }).recommendation).toBe('NO_GO');
  });
  it('knockouts force NO_GO even with high score', () => {
    const s = all(5); s.certification_eligibility = { score: 1 };
    const r = scoreBid({ scores: s, conflictOfInterest: false });
    expect(r.recommendation).toBe('NO_GO');
    expect(r.knockouts.join()).toMatch(/sertifikasi/i);
    expect(scoreBid({ scores: all(5), conflictOfInterest: true }).recommendation).toBe('NO_GO');
  });
  it('conditional go requires conditions', () => {
    expect(() => scoreBid({ scores: all(3), conflictOfInterest: false })).toThrow(/syarat/);
  });
});

describe('Requirement extraction', () => {
  it('ignores non-requirement text and dedups', () => {
    const r = ruleExtract(['Latar belakang pengadaan ini adalah peningkatan layanan.\nPeserta wajib melampirkan NPWP perusahaan yang berlaku.\nPeserta wajib melampirkan NPWP perusahaan yang berlaku.']);
    expect(r).toHaveLength(1);
    expect(r[0].category).toBe('ADMINISTRATIVE');
  });
  it('AI output with non-verbatim excerpt is rejected; invalid JSON handled', () => {
    const pages = ['Penyedia wajib menyediakan SOC 24x7 dengan SLA P1 30 menit.'];
    const ok = verifyAiRequirements(JSON.stringify([{ category: 'TECHNICAL', requirement: 'SOC 24x7 dengan SLA P1', mandatory: true, source_excerpt: 'menyediakan SOC 24x7 dengan SLA P1' }]), pages);
    expect(ok.accepted).toHaveLength(1);
    const bad = verifyAiRequirements(JSON.stringify([{ category: 'TECHNICAL', requirement: 'Wajib ISO 20000', mandatory: true, source_excerpt: 'wajib memiliki ISO 20000-1' }]), pages);
    expect(bad.rejected).toBe(1);
    expect(verifyAiRequirements('maaf saya tidak bisa', pages).error).toMatch(/JSON/);
  });
  it('relevance scoring classifies cybersecurity vs non-IT', () => {
    expect(scoreRelevance('Jasa Penetration Testing dan VAPT aplikasi').classification).toBe('CYBERSECURITY');
    expect(scoreRelevance('Pengadaan kursi kantor').score).toBe(0);
  });
});

describe('Claim guard', () => {
  const ctx = 'Peserta wajib memiliki sertifikat ISO/IEC 27001. Terdaftar (whitelisted) di BSSN sebagai Lembaga Konsultan Sistem Manajemen Pengamanan Informasi.';
  it('allows claims grounded in context, flags new ones', () => {
    expect(unsupportedClaims('Layanan sesuai ISO 27001.', ctx)).toEqual([]);
    expect(unsupportedClaims('Terdaftar di BSSN sebagai Lembaga Konsultan Sistem Manajemen Pengamanan Informasi.', ctx)).toEqual([]);
    expect(unsupportedClaims('Tim kami tersertifikasi OSCP dan CISSP.', ctx).length).toBeGreaterThan(0);
    expect(unsupportedClaims('Berpengalaman 15 tahun melayani 200+ klien perbankan.', ctx).length).toBe(2);
    expect(unsupportedClaims('Kami adalah gold partner Fortinet.', ctx).length).toBe(1);
  });
  it('line diff reports only changes', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([{ op: 'del', line: 'b' }, { op: 'add', line: 'B' }]);
  });
});

describe('CTI tier rules', () => {
  it('RFI > 6 forces Enterprise; small SME is Basic', () => {
    expect(sizeCti(CtiInput.parse({ domains: 1, rfiPerMonth: 8 }), P.cti, 'other', 1).tier.key).toBe('enterprise');
    expect(sizeCti(CtiInput.parse({ domains: 1 }), P.cti, 'other', 1).tier.key).toBe('standard'); // 1.5 + 1 = 2.5
    expect(sizeCti(CtiInput.parse({ domains: 1 }), { ...P.cti, industryRisk: { other: 0.5 } }, 'other', 1).tier.key).toBe('basic');
  });
});
