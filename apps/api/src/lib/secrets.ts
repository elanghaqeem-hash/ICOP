import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Enkripsi rahasia aplikasi (API key AI) — AES-256-GCM, format "v1:<iv>:<tag>:<ciphertext>" (base64).
 * Kunci master: env SECRETS_MASTER_KEY (32 byte, base64/hex). Di non-production, bila kosong,
 * diturunkan dari JWT_SECRET via HKDF (dengan peringatan). Di production wajib diisi.
 */
let cached: Buffer | null = null;
export function masterKey(): Buffer {
  if (cached) return cached;
  const raw = process.env.SECRETS_MASTER_KEY;
  if (raw) {
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length !== 32) throw new Error('SECRETS_MASTER_KEY harus 32 byte (hex 64 karakter atau base64)');
    cached = buf;
  } else {
    if (config.nodeEnv === 'production') throw new Error('SECRETS_MASTER_KEY wajib diisi di production untuk menyimpan API key');
    cached = Buffer.from(hkdfSync('sha256', config.jwtSecret, 'icop-secrets', 'ai-provider-keys', 32));
  }
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Format rahasia tidak dikenal');
  const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
export const last4 = (s: string) => (s.length <= 8 ? '****' : `…${s.slice(-4)}`);
