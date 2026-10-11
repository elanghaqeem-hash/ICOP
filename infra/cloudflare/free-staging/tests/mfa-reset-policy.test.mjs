import test from 'node:test';
import assert from 'node:assert/strict';
import { planMfaReset } from '../src/security/mfa-reset-policy.mjs';

const actor = {
  id:'admin-a', tenantId:'tenant-deit', role:'company_admin',
  isActive:true, mfaEnabled:true, mfaVerified:true, forcePasswordChange:false,
};
const target = {
  id:'user-b', tenantId:'tenant-deit', isActive:true, tokenVersion:3,
};
const valid='User lost device; reset approved after verification';

test('UAT U02/U24 — valid administrative MFA recovery creates only a plan',()=>{
  const r=planMfaReset({actor,target,reason:valid});
  assert.equal(r.allowed,true);
  assert.equal(r.plan.nextTokenVersion,4);
  assert.equal(r.plan.revokeAllSessions,true);
  assert.equal(r.plan.clearMfaEnrollment,true);
  assert.equal(r.plan.requireReenrollment,true);
  assert.equal(r.plan.auditAction,'auth.mfa_reset');
  assert.equal(r.plan.actorId,'admin-a');
  assert.equal(r.plan.targetId,'user-b');
  assert.equal(r.plan.reason,valid);
});
test('UAT U02 — prevent self reset and cross tenant administrator reset',()=>{
  assert.equal(planMfaReset({actor,target:{...target,id:actor.id},reason:valid}).code,'SELF_RESET_FORBIDDEN');
  assert.equal(planMfaReset({actor,target:{...target,tenantId:'other-tenant'},reason:valid}).code,'TENANT_DENIED');
});
test('UAT U02 — inactive, unenrolled MFA and unauthorized roles denied',()=>{
  assert.equal(planMfaReset({actor:{...actor,mfaVerified:false},target,reason:valid}).code,'MFA_REQUIRED');
  assert.equal(planMfaReset({actor:{...actor,mfaEnabled:false},target,reason:valid}).code,'MFA_REQUIRED');
  assert.equal(planMfaReset({actor:{...actor,role:'customer_user'},target,reason:valid}).code,'PERMISSION_DENIED');
  assert.equal(planMfaReset({actor,target:{...target,isActive:false},reason:valid}).code,'TARGET_INACTIVE');
});
test('UAT U02 — require 10–500 character audit reason and valid revocation counter',()=>{
  for(const reason of [undefined,null,'', 'lost', 'x'.repeat(501)]) {
    assert.equal(planMfaReset({actor,target,reason}).code,'REASON_REQUIRED');
  }
  for(const tokenVersion of [undefined,-1,0.5,Number.MAX_SAFE_INTEGER]) {
    assert.equal(planMfaReset({actor,target:{...target,tokenVersion},reason:valid}).code,'TOKEN_VERSION_INVALID');
  }
});
test('preflight only: reset creates no DB updates or sessions',()=>{
  const r=planMfaReset({actor,target,reason:valid});
  assert.deepEqual(Object.keys(r).sort(),['allowed','plan']);
  // The future D1 handler MUST enforce this policy with verified identities,
  // atomically clear enrollment + revoke sessions and append audit before
  // claiming U02 passed. No HTTP reset route is installed by this helper.
});
