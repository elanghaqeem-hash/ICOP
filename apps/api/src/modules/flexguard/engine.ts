import { z } from 'zod';
import type { FlexguardPolicy } from '../pricing/policy-defaults.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const ceilTo = (n: number, step: number) => Math.ceil(n / step - 1e-9) * step;

/* ───────────────────────── Kalkulator paket (H1) ───────────────────────── */

export const CalculatorInput = z.object({
  tokens: z.number().positive().max(100_000),
  pricePerToken: z.number().positive().optional(), // special commercial rate (opsional)
  contractMonths: z.number().int().min(1).max(60).optional(),
  taxRatePct: z.number().min(0).max(20).default(11),
  plannedUsage: z.array(z.object({ serviceLine: z.string(), lines: z.array(z.object({ role: z.string(), md: z.number().min(0) })).min(1),
    timesPerYear: z.number().min(0).max(52).default(1), overseas: z.boolean().default(false), rush: z.boolean().default(false) })).max(30).default([]),
});
export type CalculatorInput = z.infer<typeof CalculatorInput>;

export function packageFor(p: FlexguardPolicy, tokens: number) {
  return p.ladder.find((l) => tokens >= l.min && (l.max === null || tokens <= l.max)) ?? null;
}

/** Konversi MD per peran → token (Σ MD × TDC × pengali, dibulatkan ke atas 0,5) + biaya internal & floor. */
export function estimateTokens(p: FlexguardPolicy, lines: { role: string; md: number; tdc?: number }[], opts: { overseas?: boolean; rush?: boolean; overseasMultiplier?: number } = {}) {
  const warnings: string[] = [];
  const detail = lines.filter((l) => l.md > 0).map((l) => {
    const base = p.tdc[l.role];
    if (base === undefined) throw new Error(`Peran '${l.role}' tidak dikenal di tabel TDC`);
    let tdc = base;
    if (l.tdc !== undefined && l.tdc !== base) {
      const range = p.tdcRange[l.role];
      if (!range || l.tdc < range[0] || l.tdc > range[1]) throw new Error(`TDC ${l.role} tidak boleh diubah di luar range kebijakan (no under-debit)`);
      tdc = l.tdc;
    }
    const rate = p.internalRate[l.role];
    return { role: l.role, md: l.md, tdc, tokens: r2(l.md * tdc), internalCost: l.md * rate };
  });
  if (!detail.length) throw new Error('Isi minimal satu peran dengan MD > 0');
  const loc = opts.overseas ? (opts.overseasMultiplier ?? p.multipliers.overseas) : 1;
  const urg = opts.rush ? p.multipliers.rush : 1;
  if (loc < 1 || loc > 2.5) throw new Error('Pengali overseas harus 2,0–2,5');
  const raw = detail.reduce((s, d) => s + d.tokens, 0) * loc * urg;
  const tokens = ceilTo(raw, p.roundTo);
  const sdmCost = detail.reduce((s, d) => s + d.internalCost, 0) * loc;
  const totalCost = sdmCost * (1 + p.overheadRatio);
  const floorValue = Math.round(totalCost / p.floorMarginDivisor);
  if (opts.rush) warnings.push('Pengali rush ×1,25 diterapkan');
  return { lines: detail, multipliers: { location: loc, urgency: urg }, rawTokens: r2(raw), tokens, totalMd: detail.reduce((s, d) => s + d.md, 0), sdmCost, totalCost, floorValue, warnings };
}

/** Floor guard: nilai debit (token × harga efektif token klien) ≥ FLOOR. */
export function floorCheck(tokens: number, pricePerToken: number, floorValue: number) {
  const value = Math.round(tokens * pricePerToken);
  return { debitValue: value, floorValue, belowFloor: value < floorValue, gapPct: floorValue ? r2(((value - floorValue) / floorValue) * 100) : 0 };
}

export function complimentaryFor(p: FlexguardPolicy, tokens: number) {
  return p.complimentary.filter((c) => ('minExclusive' in c && c.minExclusive !== undefined ? tokens > c.minExclusive : tokens >= (c as { minInclusive: number }).minInclusive)).map((c) => c.item);
}

export function calculate(p: FlexguardPolicy, input: CalculatorInput) {
  const warnings: string[] = [];
  const pkg = packageFor(p, input.tokens);
  if (input.tokens < p.minTokens) warnings.push(`Minimum pembelian ${p.minTokens} token`);
  const listPrice = pkg?.price ?? p.trv;
  const price = input.pricePerToken ?? listPrice;
  const special = input.pricePerToken !== undefined && input.pricePerToken !== listPrice;
  // Floor per token: 1 Senior-MD (biaya SDM + overhead) / 0,8
  const floorPerToken = Math.round((p.internalRate.senior * (1 + p.overheadRatio)) / p.floorMarginDivisor);
  const belowFloor = price < floorPerToken;
  if (special) warnings.push(`Harga khusus Rp${price.toLocaleString('id-ID')}/token (list paket ${pkg?.package ?? '-'} Rp${listPrice.toLocaleString('id-ID')}) — special commercial deal, bukan rate card global`);
  if (belowFloor) warnings.push(`Harga/token di bawah floor Rp${floorPerToken.toLocaleString('id-ID')} — wajib approval Direktur (BELOW_FLOOR)`);
  const validMonths = input.contractMonths ?? pkg?.validMonths ?? 12;
  const bonusTokens = special ? 0 : r2(input.tokens * (pkg?.bonusPct ?? 0) / 100);
  if (special && pkg?.bonusPct) warnings.push('Bonus token tidak berlaku untuk harga khusus');
  const subtotal = Math.round(input.tokens * price);
  const tax = Math.round(subtotal * input.taxRatePct / 100);
  const usage = input.plannedUsage.map((u) => {
    const e = estimateTokens(p, u.lines, { overseas: u.overseas, rush: u.rush });
    const fc = floorCheck(e.tokens, price, e.floorValue);
    return { serviceLine: u.serviceLine, tokensPerRun: e.tokens, timesPerYear: u.timesPerYear, tokensPerYear: r2(e.tokens * u.timesPerYear),
      effectiveCostPerRun: Math.round(e.tokens * price), listValuePerRun: Math.round(e.tokens * p.trv), floorValue: e.floorValue, belowFloor: fc.belowFloor };
  });
  const yearly = usage.reduce((s, u) => s + u.tokensPerYear, 0);
  const totalTokens = input.tokens + bonusTokens;
  const monthsToDeplete = yearly > 0 ? r2((totalTokens / yearly) * 12) : null;
  if (usage.some((u) => u.belowFloor)) warnings.push('Sebagian layanan bernilai di bawah floor pada harga token ini — debit layanan tersebut butuh approval');
  if (monthsToDeplete !== null && monthsToDeplete > validMonths) warnings.push(`Estimasi pemakaian ${monthsToDeplete} bulan melebihi masa berlaku ${validMonths} bulan — risiko token hangus (pertimbangkan paket lebih kecil/rollover)`);
  const membership = p.membership.find((m) => totalTokens >= m.min)?.name ?? null;
  return {
    package: pkg?.package ?? 'Custom', listPricePerToken: listPrice, pricePerToken: price, specialDeal: special, floorPerToken, belowFloor,
    tokens: input.tokens, bonusTokens, totalTokens, validMonths, rollover: pkg?.rollover ?? false,
    subtotal, taxRatePct: input.taxRatePct, tax, total: subtotal + tax, discountVsTrvPct: r2((1 - price / p.trv) * 100),
    complimentary: complimentaryFor(p, input.tokens), membership,
    plannedUsage: usage, tokensPerYear: r2(yearly), monthsToDeplete,
    topUpRecommendation: monthsToDeplete !== null && monthsToDeplete < validMonths ? Math.ceil((yearly * validMonths / 12 - totalTokens) / p.roundTo) * p.roundTo : 0,
    warnings,
  };
}
