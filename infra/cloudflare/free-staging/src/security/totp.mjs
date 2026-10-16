/**
 * ICOP Cloudflare Worker TOTP helper (RFC4226 / RFC6238).
 * Matches the Fastify SHA1 / six-digit / 30-second contract.
 *
 * Staging-only building block; does not issue or authorize sessions.
 * Never expose plaintext secrets to browser responses/logging.
 */
export const TOTP_PERIOD = 30;
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();

function decodeBase32(secret) {
  if (typeof secret !== 'string' || secret.length < 16 || secret.length > 128) {
    throw new TypeError('Invalid TOTP secret');
  }
  const upper = secret.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(upper)) throw new TypeError('Invalid TOTP secret');
  let acc = 0, bits = 0;
  const output = [];
  for (const ch of upper) {
    acc = (acc << 5) | ABC.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((acc >>> bits) & 255);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0 && acc !== 0) throw new TypeError('Invalid TOTP padding');
  if (output.length < 10) throw new TypeError('TOTP key too short');
  return new Uint8Array(output);
}
function compareCode(a,b) {
  if (a.length !== 6 || b.length !== 6) return false;
  let diff = 0;
  for (let i = 0; i < 6; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function importTotpKey(secret) {
  return crypto.subtle.importKey('raw',decodeBase32(secret),{name:'HMAC',hash:'SHA-1'},false,['sign']);
}
async function totpWithKey(key, step) {
  if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('Invalid TOTP step');
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0,BigInt(step),false);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC',key,counter));
  const off = mac[mac.length-1] & 15;
  const bin = ((mac[off] & 0x7f) * 0x1000000) +
    (mac[off+1] << 16) + (mac[off+2] << 8) + mac[off+3];
  return String(bin % 1000000).padStart(6,'0');
}
export async function totpAt(secret, step) {
  return totpWithKey(await importTotpKey(secret),step);
}
export async function matchTotp(secret, code, lastUsedStep=-1, nowMs=Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      !Number.isFinite(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(lastUsedStep) || lastUsedStep < -1) return null;
  const nowStep = Math.floor(nowMs / (TOTP_PERIOD * 1000));
  if (!Number.isSafeInteger(nowStep)) return null;
  const key = await importTotpKey(secret);
  let match = null;
  // Evaluate the full window, then enforce last-used-step: no early match
  // exit that would add code-dependent timing information.
  for (const step of [nowStep-1,nowStep,nowStep+1]) {
    if (step < 0) continue;
    const candidate = await totpWithKey(key,step);
    if (compareCode(candidate,code) && step > lastUsedStep) match = step;
  }
  return match;
}

/**
 * Atomic D1 replay guard. A duplicate (tenant,user,step) can never be accepted
 * twice because the D1 primary key enforces uniqueness. Call only after
 * successful password + identity verification AND TOTP match; deny if false.
 * Does NOT make the overall login operation transactional.
 */
export async function reserveTotpStep(db, tenantId, userId, step, nowSeconds=Math.floor(Date.now()/1000)) {
  if (!db || typeof db.prepare !== 'function' ||
      ![tenantId,userId].every(v => typeof v === 'string' && /^[a-zA-Z0-9_-]{2,128}$/.test(v)) ||
      !Number.isSafeInteger(step) || step < 0 ||
      !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return false;
  try {
    const result = await db.prepare(
      'INSERT INTO mfa_used_steps(tenant_id,user_id,totp_step,used_at) VALUES(?,?,?,?)'
    ).bind(tenantId,userId,step,nowSeconds).run();
    return result?.success === true && result?.meta?.changes === 1;
  } catch {
    // Duplicate, foreign-key failure, or unavailable D1 all deny. Never fall
    // through on a database error.
    return false;
  }
}
