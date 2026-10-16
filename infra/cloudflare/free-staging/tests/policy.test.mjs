import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationGate, mustUseMfa, ROLES } from '../src/security/policy.mjs';

const ready = (role='company_admin') => ({
  id:'user-a', tenantId:'tenant-a', role, isActive:true,
  mfaEnabled:true, mfaVerified:true, forcePasswordChange:false,
});
test('schema roles match source and privileged MFA is mandatory', () => {
  assert.equal(ROLES.length,20);
  for (const role of ['super_admin','company_admin','director','vp_head',
                      'sales_manager','pricing_finance','legal','tender_officer']) {
    assert.equal(mustUseMfa(role,false),true);
  }
  assert.equal(mustUseMfa('customer_user',false),false);
  assert.equal(mustUseMfa('customer_user',true),true);
});
test('cross-tenant, inactive and first-login user denied before permission evaluation',()=>{
  assert.equal(authorizationGate({actor:ready(),resourceTenantId:'tenant-b',permission:'user.manage'}),'TENANT_DENIED');
  assert.equal(authorizationGate({actor:{...ready(),isActive:false},resourceTenantId:'tenant-a',permission:'user.manage'}),'INACTIVE_ACCOUNT');
  assert.equal(authorizationGate({actor:{...ready(),forcePasswordChange:true},resourceTenantId:'tenant-a',permission:'user.manage'}),'PASSWORD_CHANGE_REQUIRED');
  assert.equal(authorizationGate({actor:{...ready(),mfaVerified:false},resourceTenantId:'tenant-a',permission:'user.manage'}),'MFA_REQUIRED');
});
test('privileged and stale sessions without enrolled MFA fail closed',()=>{
  const missingEnrollment = {...ready('super_admin'),mfaEnabled:false,mfaVerified:true};
  assert.equal(authorizationGate({actor:missingEnrollment,resourceTenantId:'tenant-a',permission:'user.manage'}),'MFA_REQUIRED');
  const missingBoth = {...ready('director'),mfaEnabled:false,mfaVerified:false};
  assert.equal(authorizationGate({actor:missingBoth,resourceTenantId:'tenant-a',permission:'approval.decide'}),'MFA_REQUIRED');
  const inconsistentCustomer = {...ready('customer_user'),mfaEnabled:false,mfaVerified:true};
  assert.equal(authorizationGate({actor:inconsistentCustomer,resourceTenantId:'tenant-a',permission:'portal.access'}),'MFA_REQUIRED');
});

test('deny-by-default scope and SoD: superadmin cannot decide pricing approval',()=>{
  assert.equal(authorizationGate({actor:ready('super_admin'),resourceTenantId:'tenant-a',permission:'approval.decide'}),'PERMISSION_DENIED');
  assert.equal(authorizationGate({actor:ready('company_admin'),resourceTenantId:'tenant-a',permission:'user.manage'}),'ALLOW');
  assert.equal(authorizationGate({actor:ready('company_admin'),resourceTenantId:'tenant-a',permission:'unknown.command'}),'PERMISSION_DENIED');
  assert.equal(authorizationGate({actor:ready('customer_user'),resourceTenantId:'tenant-a',permission:'portal.access'}),'ALLOW');
  assert.equal(authorizationGate({actor:ready('customer_user'),resourceTenantId:'tenant-a',permission:'pricing.view_cost'}),'PERMISSION_DENIED');
});
