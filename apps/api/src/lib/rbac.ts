export const ROLES = [
  'super_admin', 'company_admin', 'director', 'vp_head', 'sales_manager', 'account_manager',
  'presales_engineer', 'solution_architect', 'pricing_finance', 'legal', 'tender_officer',
  'procurement_officer', 'project_manager', 'delivery_engineer', 'soc_operations',
  'product_manager', 'customer_support', 'auditor', 'partner_user', 'customer_user',
] as const;
export type Role = (typeof ROLES)[number];

const INTERNAL: Role[] = ROLES.filter((r) => r !== 'customer_user' && r !== 'partner_user');
const SALES_MGMT: Role[] = ['sales_manager', 'account_manager', 'vp_head', 'director', 'company_admin', 'super_admin'];
const PRESALES: Role[] = ['presales_engineer', 'solution_architect'];

export const PERMISSIONS: Record<string, Role[]> = {
  'customer.read': INTERNAL,
  'customer.write': SALES_MGMT,
  'opportunity.read': [...SALES_MGMT, ...PRESALES, 'pricing_finance', 'auditor', 'tender_officer'],
  'opportunity.write': SALES_MGMT,
  'catalog.read': INTERNAL,
  'catalog.write': ['product_manager', 'company_admin', 'pricing_finance', 'super_admin'],
  'assessment.read': [...SALES_MGMT, ...PRESALES, 'pricing_finance', 'auditor'],
  'assessment.write': [...PRESALES, 'account_manager', 'sales_manager'],
  'assessment.review': PRESALES,
  'pricing.calculate': [...PRESALES, 'pricing_finance', 'account_manager', 'sales_manager', 'vp_head', 'director'],
  'pricing.view_cost': [...PRESALES, 'pricing_finance', 'sales_manager', 'vp_head', 'director', 'auditor', 'company_admin', 'super_admin'],
  'policy.read': [...PRESALES, 'pricing_finance', 'sales_manager', 'vp_head', 'director', 'auditor', 'company_admin', 'super_admin'],
  'policy.manage': ['pricing_finance', 'company_admin', 'super_admin'],
  'policy.activate': ['director', 'company_admin'],
  'quotation.read': [...SALES_MGMT, ...PRESALES, 'pricing_finance', 'legal', 'auditor'],
  'quotation.write': ['account_manager', 'sales_manager', 'presales_engineer'],
  'quotation.submit': ['account_manager', 'sales_manager'],
  'approval.read': ['sales_manager', 'vp_head', 'director', 'auditor', 'company_admin', 'account_manager', 'presales_engineer'],
  'approval.decide': ['sales_manager', 'vp_head', 'director'],
  'ai.use': INTERNAL,
  'ai.admin': ['company_admin', 'super_admin'],
  'audit.read': ['auditor', 'company_admin', 'super_admin', 'director'],
  'dashboard.read': [...SALES_MGMT, 'pricing_finance', 'auditor'],
  'user.manage': ['company_admin', 'super_admin'],
  'portal.access': ['customer_user'],
  'tender.read': [...SALES_MGMT, ...PRESALES, 'tender_officer', 'legal', 'pricing_finance', 'auditor', 'procurement_officer'],
  'tender.write': ['tender_officer', 'sales_manager', 'account_manager', 'presales_engineer', 'solution_architect', 'vp_head', 'director'],
  'proposal.read': [...SALES_MGMT, ...PRESALES, 'tender_officer', 'legal', 'auditor'],
  'proposal.write': [...PRESALES, 'account_manager', 'sales_manager', 'tender_officer'],
  'proposal.review': PRESALES,
  'vendor.read': [...PRESALES, 'pricing_finance', 'procurement_officer', 'product_manager', 'sales_manager', 'vp_head', 'director', 'auditor'],
  'vendor.write': ['procurement_officer', 'product_manager', 'pricing_finance', 'presales_engineer'],
  'facts.read': INTERNAL,
  'facts.manage': ['company_admin', 'legal', 'product_manager', 'presales_engineer'],
  'facts.verify': ['legal', 'company_admin', 'director'],
  'jobs.run': ['company_admin', 'super_admin'],
  'documents.read': INTERNAL,
  'flexguard.read': [...SALES_MGMT, ...PRESALES, 'pricing_finance', 'project_manager', 'delivery_engineer', 'auditor', 'legal'],
  'flexguard.write': ['account_manager', 'sales_manager', 'presales_engineer', 'vp_head', 'director'],
  'flexguard.estimate': [...PRESALES, 'project_manager'],
  'flexguard.deliver': ['project_manager', 'vp_head'],
  'flexguard.timesheet': ['delivery_engineer', 'project_manager', ...PRESALES, 'soc_operations'],
  'contract.read': [...SALES_MGMT, 'legal', 'pricing_finance', 'project_manager', 'auditor', 'presales_engineer'],
  'contract.write': ['account_manager', 'sales_manager', 'legal', 'vp_head'],
  'contract.legal': ['legal'],
  'project.read': [...SALES_MGMT, 'project_manager', 'delivery_engineer', 'pricing_finance', 'auditor', 'presales_engineer', 'legal', 'solution_architect', 'soc_operations'],
  'project.manage': ['project_manager', 'vp_head', 'director', 'company_admin'],
  'integration.admin': ['company_admin', 'super_admin'],
  'template.read': [...INTERNAL],
  'template.approve': ['legal'],
  'billing.read': [...SALES_MGMT, 'pricing_finance', 'project_manager', 'auditor', 'legal'],
  'billing.write': ['pricing_finance', 'company_admin'],
  'billing.approve': ['pricing_finance', 'company_admin', 'director', 'vp_head'],
  'project.timesheet': ['delivery_engineer', 'project_manager', 'presales_engineer', 'solution_architect', 'soc_operations'],
  'helpdesk.read': INTERNAL.filter((r) => r !== 'partner_user'),
  'helpdesk.work': ['soc_operations', 'delivery_engineer', 'project_manager', 'presales_engineer', 'account_manager', 'sales_manager', 'vp_head', 'director', 'company_admin'],
  'documents.write': INTERNAL.filter((r) => r !== 'auditor'),
};

export function can(role: string, perm: string): boolean {
  if (role === 'super_admin' && !perm.startsWith('portal.') && !['policy.activate', 'approval.decide', 'facts.verify', 'proposal.review', 'contract.legal'].includes(perm)) return true;
  return (PERMISSIONS[perm] ?? []).includes(role as Role);
}

/** Approval authority level per role (DoA). 0 = no authority. */
export const APPROVAL_LEVEL: Record<string, number> = {
  sales_manager: 1, // Manager
  vp_head: 2,       // VP / Head
  director: 3,      // Direktur
};
export const LEVEL_LABEL: Record<number, string> = { 1: 'Manager', 2: 'VP/Head', 3: 'Direktur' };
