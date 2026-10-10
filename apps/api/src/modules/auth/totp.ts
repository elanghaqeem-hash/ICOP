import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 4226 / 6238 — six-digit, SHA-1, 30-second TOTP for standard
// authenticator applications. Never log or persist the base32 plaintext.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;
export function newTotpSecret(): string {
  let bits = 0, acc = 0, out = '';
  for (const byte of randomBytes(20)) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += alphabet[(acc >>> bits) & 31]; }
  }
  return out;
}
function decodeBase32(value: string): Buffer {
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(char);
    if (idx < 0) throw new Error('Invalid base32 TOTP secret');
    acc = (acc << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const value = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, '0');
}
export function matchTotp(secret: string, code: string, lastUsedStep = -1, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const nowStep = Math.floor(nowMs / (TOTP_PERIOD * 1000));
  const got = Buffer.from(code);
  // Only fresh, previously unused codes can be accepted (including drift).
  for (const step of [nowStep - 1, nowStep, nowStep + 1]) {
    if (step <= lastUsedStep || step < 0) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, got)) return step;
  }
  return null;
}
export function provisioningUri(secret: string, email: string): string {
  const issuer = 'ICOP CyberBusiness 360';
  return `otpauth://totp/${encodeURIComponent(issuer + ':' + email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD}`;
}
