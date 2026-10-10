import type { Tx } from '../../db.js';
import { notify } from '../../lib/context.js';
import { conflict, notFound, unprocessable } from '../../lib/errors.js';

export type TxType = 'FUND' | 'TOPUP' | 'BONUS' | 'RESERVE' | 'RELEASE' | 'CONSUME' | 'REVERSAL' | 'ADJUSTMENT' | 'EXPIRE' | 'ROLLOVER';
export interface Delta { available?: number; reserved?: number; consumed?: number; expired?: number; credited?: number }
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Satu-satunya jalan mengubah saldo wallet: kunci baris wallet (FOR UPDATE), validasi, tulis ledger append-only,
 * perbarui saldo cache dalam transaksi yang sama. Idempotency-key per wallet mencegah transaksi ganda.
 */
export async function post(tx: Tx, args: { tenantId: string; walletId: string; type: TxType; delta: Delta; reason: string; userId: string | null;
  serviceRequestId?: string | null; reversesTxId?: number | null; approvalRequestId?: string | null; idempotencyKey?: string | null; valueIdr?: number | null; allowInactive?: boolean }) {
  const [w] = await tx`SELECT * FROM flexguard_wallets WHERE id = ${args.walletId} AND tenant_id = ${args.tenantId} FOR UPDATE`;
  if (!w) throw notFound('Wallet');
  if (args.idempotencyKey) {
    const [prev] = await tx`SELECT * FROM wallet_transactions WHERE wallet_id = ${args.walletId} AND idempotency_key = ${args.idempotencyKey}`;
    if (prev) return { tx: prev, wallet: w, replay: true };
  }
  if (w.status !== 'ACTIVE' && !args.allowInactive) throw unprocessable(`Wallet berstatus ${w.status}`);
  const d = { available: r2(args.delta.available ?? 0), reserved: r2(args.delta.reserved ?? 0), consumed: r2(args.delta.consumed ?? 0),
    expired: r2(args.delta.expired ?? 0), credited: r2(args.delta.credited ?? 0) };
  const next = {
    available: r2(Number(w.availableTokens) + d.available), reserved: r2(Number(w.reservedTokens) + d.reserved),
    consumed: r2(Number(w.consumedTokens) + d.consumed), expired: r2(Number(w.expiredTokens) + d.expired), credited: r2(Number(w.creditedTokens) + d.credited),
  };
  if (next.available < 0) throw unprocessable(`Saldo tersedia tidak cukup (tersedia ${w.availableTokens}, dibutuhkan ${-d.available}) — over-consumption memerlukan top-up yang disetujui`, { available: Number(w.availableTokens) });
  if (next.reserved < 0 || next.consumed < 0 || next.expired < 0) throw conflict('Transaksi akan membuat saldo negatif');
  const [row] = await tx`INSERT INTO wallet_transactions (tenant_id, wallet_id, type, d_available, d_reserved, d_consumed, d_expired, d_credited, value_idr,
      service_request_id, reverses_tx_id, approval_request_id, reason, idempotency_key, balance_after, created_by)
    VALUES (${args.tenantId}, ${args.walletId}, ${args.type}, ${d.available}, ${d.reserved}, ${d.consumed}, ${d.expired}, ${d.credited},
      ${args.valueIdr ?? r2((Math.abs(d.consumed) || Math.abs(d.credited) || Math.abs(d.reserved) || Math.abs(d.available)) * Number(w.pricePerToken))},
      ${args.serviceRequestId ?? null}, ${args.reversesTxId ?? null}, ${args.approvalRequestId ?? null}, ${args.reason}, ${args.idempotencyKey ?? null},
      ${tx.json(next as never)}, ${args.userId}) RETURNING *`;
  await tx`UPDATE flexguard_wallets SET available_tokens = ${next.available}, reserved_tokens = ${next.reserved}, consumed_tokens = ${next.consumed},
           expired_tokens = ${next.expired}, credited_tokens = ${next.credited} WHERE id = ${args.walletId}`;
  // Low-balance alert (≤ ambang % dari total kredit), sekali per periode sampai saldo pulih
  const pct = next.credited > 0 ? (next.available / next.credited) * 100 : 100;
  if (pct <= Number(w.lowBalancePct) && !w.lowBalanceAlertedAt && ['RESERVE', 'CONSUME', 'EXPIRE'].includes(args.type)) {
    const users = await tx`SELECT id FROM users WHERE tenant_id = ${args.tenantId} AND is_active AND (customer_id = ${w.customerId} OR role IN ('account_manager','sales_manager'))`;
    await notify(tx, args.tenantId, users.map((u) => u.id as string), 'FLEXGUARD_LOW_BALANCE', `Saldo FlexGuard ${w.code} ≤ ${w.lowBalancePct}%`,
      `Tersedia ${next.available} dari ${next.credited} token — pertimbangkan top-up`, `/flexguard/${w.id}`);
    await tx`UPDATE flexguard_wallets SET low_balance_alerted_at = now() WHERE id = ${args.walletId}`;
  } else if (pct > Number(w.lowBalancePct) && w.lowBalanceAlertedAt) {
    await tx`UPDATE flexguard_wallets SET low_balance_alerted_at = NULL WHERE id = ${args.walletId}`;
  }
  return { tx: row, wallet: { ...w, ...next }, replay: false };
}

/** Reversal: membalik efek transaksi CONSUME/ADJUSTMENT/TOPUP/FUND tanpa menghapus histori. */
export async function reverse(tx: Tx, args: { tenantId: string; txId: number; reason: string; userId: string; approvalRequestId?: string | null }) {
  const [orig] = await tx`SELECT * FROM wallet_transactions WHERE id = ${args.txId} AND tenant_id = ${args.tenantId}`;
  if (!orig) throw notFound('Transaksi');
  if (!['CONSUME', 'ADJUSTMENT', 'TOPUP', 'BONUS'].includes(orig.type as string)) throw unprocessable(`Transaksi ${orig.type} tidak dapat di-reverse (gunakan RELEASE untuk reservasi)`);
  const [already] = await tx`SELECT id FROM wallet_transactions WHERE reverses_tx_id = ${args.txId}`;
  if (already) throw conflict('Transaksi ini sudah di-reverse');
  return post(tx, { tenantId: args.tenantId, walletId: orig.walletId as string, type: 'REVERSAL', reason: args.reason, userId: args.userId, reversesTxId: args.txId,
    serviceRequestId: (orig.serviceRequestId as string) ?? null, approvalRequestId: args.approvalRequestId ?? null,
    // CONSUME: token kembali ke saldo tersedia (reservasi sudah selesai); kredit (TOPUP/BONUS/ADJUSTMENT): dibatalkan
    delta: orig.type === 'CONSUME' ? { consumed: -Number(orig.dConsumed), available: Number(orig.dConsumed) }
      : { available: -Number(orig.dAvailable), credited: -Number(orig.dCredited) } });
}

/** Rekonsiliasi saldo cache vs Σ ledger. */
export async function reconcile(tx: Tx | any, walletId: string) {
  const [s] = await tx`SELECT coalesce(sum(d_available),0) AS available, coalesce(sum(d_reserved),0) AS reserved, coalesce(sum(d_consumed),0) AS consumed,
                              coalesce(sum(d_expired),0) AS expired, coalesce(sum(d_credited),0) AS credited, count(*)::int AS n FROM wallet_transactions WHERE wallet_id = ${walletId}`;
  const [w] = await tx`SELECT available_tokens, reserved_tokens, consumed_tokens, expired_tokens, credited_tokens FROM flexguard_wallets WHERE id = ${walletId}`;
  const ledger = { available: Number(s.available), reserved: Number(s.reserved), consumed: Number(s.consumed), expired: Number(s.expired), credited: Number(s.credited) };
  const cache = { available: Number(w.availableTokens), reserved: Number(w.reservedTokens), consumed: Number(w.consumedTokens), expired: Number(w.expiredTokens), credited: Number(w.creditedTokens) };
  const ok = (Object.keys(ledger) as (keyof typeof ledger)[]).every((k) => Math.abs(ledger[k] - cache[k]) < 0.005)
    && Math.abs(ledger.credited - (ledger.available + ledger.reserved + ledger.consumed + ledger.expired)) < 0.005;
  return { ok, ledger, cache, transactions: s.n };
}
