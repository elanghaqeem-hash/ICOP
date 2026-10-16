#!/usr/bin/env node
/**
 * ICOP UAT U01/U02 recovery migration: staging D1 ONLY.
 * Default = source validation (offline). --check = read-only remote preflight.
 * --apply additionally requires exact operator approval string; uses the
 * complete SQL file, never splits CREATE TRIGGER statements over D1 HTTP.
 * No tenant, user, password, secret, session or role is ever created here.
 */
import { readFileSync, mkdtempSync, statSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(dir, 'wrangler.jsonc'), 'utf8'));
const sqlPath = join(dir, 'migrations', '0004_mfa_recovery_codes.sql');
const sql = readFileSync(sqlPath, 'utf8');
const EXPECTED_ACCOUNT = '208155f241d4da84e1a6a9b44b7a8d28';
const EXPECTED_DATABASE = '8a454b5e-597a-49fd-a51e-1730786de740';
const EXPECTED_AUD = 'de8e1d54820b7a0c1ddbfc808f589e14ba04555256df734a0bea328476e0c904';
const DBNAME = 'icop-staging-db';
const VERSION = '0004_cf_free_mfa_recovery_codes';
const PREVIOUS = [
  '0001_cf_free_staging_bootstrap',
  '0002_cf_free_identity_audit_schema',
  '0003_cf_free_auth_security_foundation',
];
const expectedObjects = [
  ['mfa_recovery_codes', 'table'],
  ['mfa_recovery_unused_idx', 'index'],
  ['mfa_recovery_codes_lifecycle', 'trigger'],
  ['mfa_recovery_codes_no_delete', 'trigger'],
];
function fail(message) { throw Error('STAGING_MIGRATION_GATE: ' + message); }
function checkSource() {
  if (config.name !== 'icop-staging-api' ||
      config.d1_databases?.length !== 1 ||
      config.d1_databases[0]?.database_name !== DBNAME ||
      config.d1_databases[0]?.database_id !== EXPECTED_DATABASE ||
      config.d1_databases[0]?.binding !== 'DB')
    fail('Wrangler target mismatch; refusing to run');
  if (config.vars?.ACCESS_AUD !== EXPECTED_AUD ||
      config.vars?.ACCESS_IDENTITY_ENABLED !== 'false' ||
      config.vars?.ACCESS_MFA_CONFIRMED !== 'false' ||
      config.vars?.AUTH_V2_ENABLED === 'true')
    fail('auth or MFA release gate not safely disabled');
  for (const expression of [
    /CREATE TABLE IF NOT EXISTS mfa_recovery_codes/i,
    /CREATE TRIGGER IF NOT EXISTS mfa_recovery_codes_lifecycle/i,
    /CREATE TRIGGER IF NOT EXISTS mfa_recovery_codes_no_delete/i,
    /CREATE INDEX IF NOT EXISTS mfa_recovery_unused_idx/i,
    /RECOVERY_CODE_HISTORY_IMMUTABLE/,
    /INSERT OR IGNORE INTO migration_history/,
    /0004_cf_free_mfa_recovery_codes/,
  ]) if (!expression.test(sql)) fail('canonical SQL missing required safeguards: ' + expression);
  return createHash('sha256').update(sql).digest('hex');
}

function wrangler(args) {
  const x = spawnSync('npx', ['--no-install','wrangler','d1',...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (x.error || x.status !== 0) fail('Wrangler failed (see local operator terminal; no auto-rollback). ' +
    (x.error?.message || (x.stderr || '').slice(0, 180)));
  return (x.stdout || '').trim();
}
function rows(sqlStatement) {
  const output=wrangler(['execute',DBNAME,'--remote','--config','wrangler.jsonc',
    '--command',sqlStatement,'--json']);
  let response;
  try { response=JSON.parse(output); } catch { fail('non-JSON Wrangler response; no writes performed'); }
  const items=Array.isArray(response) ? response :
    Array.isArray(response?.result) ? response.result : null;
  if (!items || items.some(x=>x?.success === false || x?.error)) fail('remote D1 query failed');
  const data=items.flatMap(x=>Array.isArray(x?.results) ? x.results : []);
  return data;
}
function migrationVersions() {
  return rows('SELECT version FROM migration_history ORDER BY version')
    .map(x=>x.version).sort();
}
function schemaObjects() {
  return rows("SELECT name,type FROM sqlite_master WHERE name LIKE 'mfa_recovery_%' ORDER BY name");
}
function count(table) {
  const result=rows('SELECT COUNT(*) AS n FROM '+table);
  if (result.length!==1 || !Number.isSafeInteger(Number(result[0].n))) fail('invalid count: '+table);
  return Number(result[0].n);
}
function assertPreflight() {
  const versions=migrationVersions();
  if (JSON.stringify(versions)!==JSON.stringify([...PREVIOUS].sort()))
    fail('expected ONLY migrations 0001–0003 before applying 0004');
  if (schemaObjects().length!==0) fail('partial or previous recovery objects detected; stop');
  if (['tenants','users','auth_sessions','audit_events'].some(t=>count(t)!==0))
    fail('staging is not empty; requires a separate data/backup review');
  return {versions,zeroData:true};
}
function assertPostflight() {
  const versions=migrationVersions();
  if (!versions.includes(VERSION) || versions.length!==4)
    fail('migration history not complete');
  const objects=schemaObjects();
  for(const [name,type] of expectedObjects)
    if(!objects.some(x=>x.name===name && x.type===type))
      fail('missing recovery safeguard: '+name);
  if (count('mfa_recovery_codes')!==0) fail('unexpected recovery records');
  if (rows('PRAGMA foreign_key_check').length!==0) fail('foreign key integrity error');
  return {versions,recoveryTableEmpty:true,objects:expectedObjects.map(x=>x[0])};
}
const mode = process.argv[2] || '--validate-source';
if (!['--validate-source','--check','--apply'].includes(mode) || process.argv.length>3)
  fail('usage: node scripts/migrate-recovery-0004.mjs [--validate-source|--check|--apply]');
const fingerprint=checkSource();
console.log(JSON.stringify({target:DBNAME,mode,sha256:fingerprint,sourceGuard:'PASS'}));
if(mode!=='--validate-source') {
  if(process.env.CLOUDFLARE_ACCOUNT_ID!==EXPECTED_ACCOUNT)
    fail('CLOUDFLARE_ACCOUNT_ID must match staging account');
  const before=assertPreflight();
  console.log(JSON.stringify({remotePreflight:'PASS',...before}));
  if(mode==='--apply') {
    if(process.env.ICOP_D1_0004_APPROVED !==
        'APPLY_0004_STAGING_ONLY_'+EXPECTED_DATABASE)
      fail('exact explicit migration authorization missing');
    const backupParent=process.env.ICOP_D1_BACKUP_DIR;
    if(!backupParent || !backupParent.startsWith('/') ||
       resolve(backupParent)===resolve(dir,'../../..') ||
       resolve(backupParent).startsWith(resolve(dir,'../../..') + '/'))
      fail('ICOP_D1_BACKUP_DIR must be an absolute protected path outside repository');
    if(!statSync(backupParent).isDirectory())
      fail('backup parent must exist and be a directory');
    // Leave a protected backup on disk for an explicit, reviewed rollback.
    // NEVER upload it to GitHub Actions artifacts or publish its contents.
    const backupDir=mkdtempSync(join(backupParent,'icop-d1-stage-0004-'));
    const backupFile=join(backupDir,'stage-before-0004.sql');
    chmodSync(backupDir,0o700);
    try {
      wrangler(['export',DBNAME,'--remote','--config','wrangler.jsonc',
        '--output',backupFile]);
      chmodSync(backupFile,0o600);
      if (statSync(backupFile).size < 100)
        fail('backup not created; migration aborted');
      // Never use --command for trigger migration: requires native file ingest.
      wrangler(['execute',DBNAME,'--remote','--yes','--config','wrangler.jsonc',
        '--file',sqlPath]);
      const after=assertPostflight();
      console.log(JSON.stringify({remoteMigration:'PASS',...after,
        backupDir, note:'Keep offline backup for review; app login remains disabled'}));
    } catch (error) {
      console.error('Migration stopped: inspect remote D1 state before any retry.');
      console.error('Preserved local backup directory: '+backupDir);
      throw error;
    }
  }
}
