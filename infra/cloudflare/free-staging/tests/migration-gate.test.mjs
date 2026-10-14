import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entry=resolve(base,'scripts/migrate-recovery-0004.mjs');
const run=args=>spawnSync(process.execPath,[entry,...args],{
  cwd:base,encoding:'utf8',
  env:{PATH:'',ICOP_D1_0004_APPROVED:'',CLOUDFLARE_API_TOKEN:''},
});
test('U01/U02: migration 0004 validates staging target, full trigger source and both disabled flags OFFLINE',()=>{
  const x=run(['--validate-source']);
  assert.equal(x.status,0,x.stderr);
  const output=JSON.parse(x.stdout);
  assert.equal(output.target,'icop-staging-db');
  assert.equal(output.mode,'--validate-source');
  assert.equal(output.sourceGuard,'PASS');
  assert.match(output.sha256,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(x.stdout,/CLOUDFLARE_API_TOKEN/);
});
test('migration gate rejects unsupported options before any remote command',()=>{
  const x=run(['--unsafe-skip-trigger']);
  assert.notEqual(x.status,0);
  assert.match(x.stderr,/STAGING_MIGRATION_GATE/);
});
