/**
 * Phase 10 — the central permission model.
 *
 * Roles are fixed in code (not a DB-configurable Role/Permission table) —
 * UserBusiness.role stays the free-text field it already was (default
 * "STAFF"), and this file is the single place that says what each of the
 * three baseline roles can actually do. This is deliberately the smaller,
 * well-scoped version of "make this configurable later without rewriting
 * every controller": a real per-business custom-role editor is a
 * meaningfully bigger feature (its own schema, its own admin UI) that
 * nothing in the existing codebase asked for yet — see the Phase 10 report
 * for the explicit scoping note. Every consumer (the guard, /auth/me, the
 * frontend) reads permissions through permissionsForRole() below, so
 * swapping this for a DB-backed lookup later is a one-function change, not
 * a rewrite of every controller.
 */

export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard.view',

  BUSINESS_VIEW: 'business.view',
  BUSINESS_EDIT: 'business.edit',

  SALES_VIEW: 'sales.view',
  SALES_CREATE: 'sales.create',
  SALES_RETURN: 'sales.return',

  PURCHASES_VIEW: 'purchases.view',
  PURCHASES_CREATE: 'purchases.create',
  PURCHASES_RETURN: 'purchases.return',

  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_ADJUST: 'inventory.adjust',
  INVENTORY_WASTAGE: 'inventory.wastage',

  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_EDIT: 'customers.edit',

  SUPPLIERS_VIEW: 'suppliers.view',
  SUPPLIERS_CREATE: 'suppliers.create',
  SUPPLIERS_EDIT: 'suppliers.edit',

  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_RECEIVE: 'payments.receive',
  PAYMENTS_MAKE: 'payments.make',
  PAYMENTS_REFUND: 'payments.refund',

  EXPENSES_VIEW: 'expenses.view',
  EXPENSES_CREATE: 'expenses.create',

  ACCOUNTS_VIEW: 'accounts.view',
  ACCOUNTS_TRANSFER: 'accounts.transfer',
  ACCOUNTS_OPENING_BALANCE: 'accounts.opening_balance',
  ACCOUNTS_MANAGE: 'accounts.manage',

  RECONCILIATION_VIEW: 'reconciliation.view',
  RECONCILIATION_RUN: 'reconciliation.run',

  RECEIVABLES_VIEW: 'receivables.view',
  PAYABLES_VIEW: 'payables.view',

  REPORTS_VIEW: 'reports.view',
  // Phase 13: Intelligence reads exactly the same underlying data
  // REPORTS_VIEW already exposes (sales, margins, freshness, wastage,
  // receivables/payables, expenses) plus the reconciliation checks
  // RECONCILIATION_VIEW exposes — it adds interpretation on top, not a
  // new data surface — so it gets its own permission but is granted
  // everywhere REPORTS_VIEW is, below.
  INTELLIGENCE_VIEW: 'intelligence.view',

  DAY_CLOSE_PREVIEW: 'day_close.preview',
  DAY_CLOSE_COMMIT: 'day_close.commit',

  PRICING_VIEW: 'pricing.view',
  PRICING_EDIT: 'pricing.edit',

  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_EDIT: 'products.edit',

  USERS_VIEW: 'users.view',
  USERS_INVITE: 'users.invite',
  USERS_EDIT: 'users.edit',
  USERS_DISABLE: 'users.disable',

  ROLES_VIEW: 'roles.view',

  AUDIT_VIEW: 'audit.view',

  WHATSAPP_VIEW: 'whatsapp.view',
  WHATSAPP_SEND: 'whatsapp.send',
  WHATSAPP_MANAGE_SETTINGS: 'whatsapp.manage_settings',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

// Section 12: "Operational + selected financial permissions... sensitive
// configuration/user-management capabilities should remain restricted."
// Deliberately excludes: accounts.opening_balance, users.*, roles.view.
const MANAGER_PERMISSIONS: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.BUSINESS_VIEW,
  PERMISSIONS.SALES_VIEW, PERMISSIONS.SALES_CREATE, PERMISSIONS.SALES_RETURN,
  PERMISSIONS.PURCHASES_VIEW, PERMISSIONS.PURCHASES_CREATE, PERMISSIONS.PURCHASES_RETURN,
  PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_ADJUST, PERMISSIONS.INVENTORY_WASTAGE,
  PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.CUSTOMERS_CREATE, PERMISSIONS.CUSTOMERS_EDIT,
  PERMISSIONS.SUPPLIERS_VIEW, PERMISSIONS.SUPPLIERS_CREATE, PERMISSIONS.SUPPLIERS_EDIT,
  PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_RECEIVE, PERMISSIONS.PAYMENTS_MAKE, PERMISSIONS.PAYMENTS_REFUND,
  PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.EXPENSES_CREATE,
  PERMISSIONS.ACCOUNTS_VIEW, PERMISSIONS.ACCOUNTS_TRANSFER,
  PERMISSIONS.RECONCILIATION_VIEW, PERMISSIONS.RECONCILIATION_RUN,
  PERMISSIONS.RECEIVABLES_VIEW, PERMISSIONS.PAYABLES_VIEW,
  PERMISSIONS.REPORTS_VIEW, PERMISSIONS.INTELLIGENCE_VIEW,
  PERMISSIONS.DAY_CLOSE_PREVIEW, PERMISSIONS.DAY_CLOSE_COMMIT,
  PERMISSIONS.PRICING_VIEW, PERMISSIONS.PRICING_EDIT,
  PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.WHATSAPP_VIEW, PERMISSIONS.WHATSAPP_SEND, PERMISSIONS.WHATSAPP_MANAGE_SETTINGS,
];

// Section 12: "operational access only... should NOT automatically
// receive: opening balance changes, account configuration, user
// management, permission management, audit deletion, sensitive financial
// configuration." Also excludes payments (money actually changing hands),
// refunds, inventory adjust/wastage (both can mask loss or theft), and
// day-close (locks the business date for everyone) — none of those are
// "operational" in the narrow sense Section 12 describes for this role.
const STAFF_PERMISSIONS: Permission[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.BUSINESS_VIEW,
  PERMISSIONS.SALES_VIEW, PERMISSIONS.SALES_CREATE,
  PERMISSIONS.PURCHASES_VIEW, PERMISSIONS.PURCHASES_CREATE,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.CUSTOMERS_CREATE,
  PERMISSIONS.SUPPLIERS_VIEW,
  PERMISSIONS.PAYMENTS_VIEW,
  PERMISSIONS.EXPENSES_VIEW, PERMISSIONS.EXPENSES_CREATE,
  PERMISSIONS.RECEIVABLES_VIEW, PERMISSIONS.PAYABLES_VIEW,
  PERMISSIONS.REPORTS_VIEW, PERMISSIONS.INTELLIGENCE_VIEW,
  PERMISSIONS.PRICING_VIEW,
  PERMISSIONS.PRODUCTS_VIEW,
  // Phase 12: STAFF already creates sales and collects payments, so they
  // can send the corresponding WhatsApp confirmation/receipt — the same
  // "operational" scope as SALES_CREATE/PAYMENTS_RECEIVE. Automation
  // settings (whatsapp.manage_settings) are MANAGER+ only, same tier as
  // PRICING_EDIT and other business-configuration permissions.
  PERMISSIONS.WHATSAPP_VIEW, PERMISSIONS.WHATSAPP_SEND,
];

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  STAFF: STAFF_PERMISSIONS,
};

/**
 * An unrecognized role (shouldn't happen given RegisterUserDto validates
 * against this same set, but a role string could in principle be edited
 * directly in the database) gets zero permissions rather than silently
 * inheriting some default — fail closed, not open.
 */
export function permissionsForRole(role: string): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: string, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

export const ASSIGNABLE_ROLES = ['OWNER', 'MANAGER', 'STAFF'] as const;
