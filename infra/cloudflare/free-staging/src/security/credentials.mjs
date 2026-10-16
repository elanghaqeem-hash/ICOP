/**
 * Cloudflare-native staging cryptography, isolated from ICOP production.
 * Source mapped: Phase 6 Fastify auth/TOTP + UAT U01/U02/U24.
 *
 * No endpoint can activate these primitives without verified Access identity,
 * MFA challenge UAT, approved account provisioning and explicit release gate.
 */
const reKey=/^[0-9a-f]{64}$/i;
const bytes=(hex)=>Uint8Array.from(hex.match(/../g),x=>parseInt(x,16));
const hex=(value)=>Array.from(value,x=>x.toString(16).padStart(2,'0')).join('');
const encoder=new TextEncoder();
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret() {
  const random=crypto.getRandomValues(new Uint8Array(20));
  let bits=0, buffer=0, out='';
  for(const byte of random) {
    buffer=(buffer<<8)|byte; bits+=8;
    while(bits>=5) {bits-=5;out+=B32[(buffer>>bits)&31];}
    buffer&=(1<<bits)-1;
  }
  if(bits) out+=B32[(buffer<<(5-bits))&31];
  return out;
}

async function cryptoKey(raw) {
  if(typeof raw!=='string'||!reKey.test(raw))throw Error('MFA_ENCRYPTION_KEY_NOT_CONFIGURED');
  return crypto.subtle.importKey('raw',bytes(raw),{name:'AES-GCM'},false,['encrypt','decrypt']);
}
function aad(tenantId,userId) {
  if(!/^[a-zA-Z0-9_-]{2,128}$/.test(tenantId??'')||! /^[a-zA-Z0-9_-]{2,128}$/.test(userId??''))throw Error('MFA_SUBJECT_INVALID');
  return encoder.encode('icop:d1:mfa:v1:'+tenantId+':'+userId);
}
export async function encryptTotpSecret({secret,keyHex,tenantId,userId}) {
  if(typeof secret!=='string'||! /^[A-Z2-7]{32}$/.test(secret))throw Error('MFA_SECRET_INVALID');
  const key=await cryptoKey(keyHex),iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(tenantId,userId)},key,encoder.encode(secret));
  return 'aes256gcm:v1:'+hex(iv)+':'+hex(new Uint8Array(encrypted));
}
export async function decryptTotpSecret({encrypted,keyHex,tenantId,userId}) {
  const key=await cryptoKey(keyHex);
  if(typeof encrypted!=='string')throw Error('MFA_CIPHERTEXT_INVALID');
  const m=/^aes256gcm:v1:([a-f0-9]{24}):([a-f0-9]{48,512})$/.exec(encrypted);
  if(!m||m[2].length%2)throw Error('MFA_CIPHERTEXT_INVALID');
  try {
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(m[1]),additionalData:aad(tenantId,userId)},key,bytes(m[2]));
    const secret=new TextDecoder('utf-8',{fatal:true}).decode(plain);
    if(!/^[A-Z2-7]{32}$/.test(secret))throw Error('MFA_CIPHERTEXT_INVALID');
    return secret;
  } catch { throw Error('MFA_CIPHERTEXT_INVALID'); }
}
export function totpUri(secret,email) {
  if(!/^[A-Z2-7]{32}$/.test(secret)||typeof email!=='string'||email.length>254||!email.includes('@'))throw Error('MFA_SUBJECT_INVALID');
  return 'otpauth://totp/'+encodeURIComponent('ICOP Staging:'+email)+'?secret='+encodeURIComponent(secret)+'&issuer=ICOP%20Staging&algorithm=SHA1&digits=6&period=30';
}

/* PBKDF2 can serve newly enrolled D1-only test identities; legacy bcrypt
 * hashes MUST be migrated through a reviewed account reset, never accepted
 * or silently reinterpreted. No shared default/admin passwords.
 */
const ITERATIONS=600000;
const constantTime=(a,b)=>{if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0;};
const validPassword=(p)=>typeof p==='string'&&p.length>=12&&p.length<=128&&/[A-Z]/.test(p)&&/[a-z]/.test(p)&&/[0-9]/.test(p)&&/[^A-Za-z0-9]/.test(p);
async function derive(p,salt,iterations=ITERATIONS) {
  const k=await crypto.subtle.importKey('raw',encoder.encode(p),'PBKDF2',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},k,256));
}
export async function hashNewPassword(password) {
  if(!validPassword(password))throw Error('PASSWORD_POLICY');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  return 'pbkdf2-sha256$'+ITERATIONS+'$'+hex(salt)+'$'+hex(await derive(password,salt));
}
export async function verifyNewPassword(password,stored) {
  if(typeof password!=='string'||password.length>128||typeof stored!=='string')return false;
  const m=/^pbkdf2-sha256\$(\d{6,7})\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(stored);
  if(!m||Number(m[1])<ITERATIONS||Number(m[1])>1000000)return false;
  const output=await derive(password,bytes(m[2]),Number(m[1]));
  return constantTime(output,bytes(m[3]));
}
