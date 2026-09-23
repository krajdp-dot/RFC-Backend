import {
  PERMISSIONS,
  ASSIGNABLE_ROLES,
  Permission,
  permissionsForRole,
  roleHasPermission,
} from './permissions.js';

/**
 * These are the guarantees the rest of Phase 10 leans on. The guard, the
 * /users/roles endpoint and the frontend's entire nav/action gating all
 * read through permissionsForRole(), so a wrong entry here is a wrong
 * answer everywhere at once — which is exactly why the invariants are
 * asserted rather than eyeballed.
 */
describe('Phase 10 — role permission matrix', () => {
  const ALL = Object.values(PERMISSIONS) as Permission[];

  it('OWNER holds every defined permission', () => {
    expect(permissionsForRole('OWNER').sort()).toEqual([...ALL].sort());
  });

  it('an unknown role fails closed with zero permissions', () => {
    expect(permissionsForRole('SUPERUSER')).toEqual([]);
    expect(permissionsForRole('')).toEqual([]);
    expect(roleHasPermission('SUPERUSER', PERMISSIONS.SALES_VIEW)).toBe(false);
  });

  it('every assignable role resolves to a non-empty, fully-defined set', () => {
    for (const role of ASSIGNABLE_ROLES) {
      const perms = permissionsForRole(role);
      expect(perms.length).toBeGreaterThan(0);
      for (const p of perms) {
        expect(ALL).toContain(p);
      }
    }
  });

  it('no role has duplicate entries', () => {
    for (const role of ASSIGNABLE_ROLES) {
      const perms = permissionsForRole(role);
      expect(new Set(perms).size).toBe(perms.length);
    }
  });

  it('permissions strictly narrow: STAFF is a subset of MANAGER is a subset of OWNER', () => {
    const staff = permissionsForRole('STAFF');
    const manager = permissionsForRole('MANAGER');
    const owner = permissionsForRole('OWNER');

    for (const p of staff) expect(manager).toContain(p);
    for (const p of manager) expect(owner).toContain(p);
    expect(staff.length).toBeLessThan(manager.length);
    expect(manager.length).toBeLessThan(owner.length);
  });

  describe('Section 12 — what MANAGER must never inherit', () => {
    const forbidden: Permission[] = [
      PERMISSIONS.ACCOUNTS_OPENING_BALANCE,
      PERMISSIONS.ACCOUNTS_MANAGE,
      PERMISSIONS.BUSINESS_EDIT,
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_EDIT,
      PERMISSIONS.USERS_DISABLE,
      PERMISSIONS.ROLES_VIEW,
    ];

    it.each(forbidden)('MANAGER does not hold %s', (permission) => {
      expect(roleHasPermission('MANAGER', permission)).toBe(false);
    });
  });

  describe('Section 12 — STAFF is operational access only', () => {
    const forbidden: Permission[] = [
      PERMISSIONS.PAYMENTS_RECEIVE,
      PERMISSIONS.PAYMENTS_MAKE,
      PERMISSIONS.PAYMENTS_REFUND,
      PERMISSIONS.INVENTORY_ADJUST,
      PERMISSIONS.INVENTORY_WASTAGE,
      PERMISSIONS.SALES_RETURN,
      PERMISSIONS.PURCHASES_RETURN,
      PERMISSIONS.DAY_CLOSE_COMMIT,
      PERMISSIONS.DAY_CLOSE_PREVIEW,
      PERMISSIONS.ACCOUNTS_VIEW,
      PERMISSIONS.ACCOUNTS_TRANSFER,
      PERMISSIONS.ACCOUNTS_OPENING_BALANCE,
      PERMISSIONS.ACCOUNTS_MANAGE,
      PERMISSIONS.RECONCILIATION_VIEW,
      PERMISSIONS.RECONCILIATION_RUN,
      PERMISSIONS.PRICING_EDIT,
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.CUSTOMERS_EDIT,
      PERMISSIONS.SUPPLIERS_CREATE,
      PERMISSIONS.SUPPLIERS_EDIT,
      PERMISSIONS.BUSINESS_EDIT,
      PERMISSIONS.AUDIT_VIEW,
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_EDIT,
      PERMISSIONS.USERS_DISABLE,
      PERMISSIONS.ROLES_VIEW,
    ];

    it.each(forbidden)('STAFF does not hold %s', (permission) => {
      expect(roleHasPermission('STAFF', permission)).toBe(false);
    });

    it('STAFF can still do the day job', () => {
      for (const permission of [
        PERMISSIONS.DASHBOARD_VIEW,
        PERMISSIONS.SALES_VIEW,
        PERMISSIONS.SALES_CREATE,
        PERMISSIONS.PURCHASES_VIEW,
        PERMISSIONS.PURCHASES_CREATE,
        PERMISSIONS.INVENTORY_VIEW,
        PERMISSIONS.CUSTOMERS_VIEW,
        PERMISSIONS.CUSTOMERS_CREATE,
        PERMISSIONS.PRODUCTS_VIEW,
        PERMISSIONS.PRICING_VIEW,
        PERMISSIONS.REPORTS_VIEW,
      ]) {
        expect(roleHasPermission('STAFF', permission)).toBe(true);
      }
    });
  });

  it('user management is OWNER-only', () => {
    for (const permission of [
      PERMISSIONS.USERS_VIEW,
      PERMISSIONS.USERS_INVITE,
      PERMISSIONS.USERS_EDIT,
      PERMISSIONS.USERS_DISABLE,
      PERMISSIONS.ROLES_VIEW,
    ]) {
      expect(roleHasPermission('OWNER', permission)).toBe(true);
      expect(roleHasPermission('MANAGER', permission)).toBe(false);
      expect(roleHasPermission('STAFF', permission)).toBe(false);
    }
  });

  it('permission string values are unique and namespaced', () => {
    const values = Object.values(PERMISSIONS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
