import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard.js';
import { PERMISSIONS, Permission } from './permissions.js';

function contextFor(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

function guardRequiring(required: Permission | undefined) {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('Phase 10 — PermissionsGuard', () => {
  it('lets an un-annotated route through untouched', () => {
    expect(guardRequiring(undefined).canActivate(contextFor({ role: 'STAFF' }))).toBe(true);
    // ...even with no authenticated user at all — JwtAuthGuard owns that call.
    expect(guardRequiring(undefined).canActivate(contextFor(undefined))).toBe(true);
  });

  it('allows a role that holds the required permission', () => {
    const guard = guardRequiring(PERMISSIONS.SALES_CREATE);
    expect(guard.canActivate(contextFor({ role: 'STAFF' }))).toBe(true);
    expect(guard.canActivate(contextFor({ role: 'MANAGER' }))).toBe(true);
    expect(guard.canActivate(contextFor({ role: 'OWNER' }))).toBe(true);
  });

  it('rejects a role that does not', () => {
    const guard = guardRequiring(PERMISSIONS.USERS_INVITE);
    expect(() => guard.canActivate(contextFor({ role: 'STAFF' }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor({ role: 'MANAGER' }))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor({ role: 'OWNER' }))).toBe(true);
  });

  it('fails closed when the request carries no role', () => {
    const guard = guardRequiring(PERMISSIONS.SALES_VIEW);
    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('fails closed on an unrecognised role rather than inheriting a default', () => {
    const guard = guardRequiring(PERMISSIONS.DASHBOARD_VIEW);
    expect(() => guard.canActivate(contextFor({ role: 'ADMIN' }))).toThrow(ForbiddenException);
  });

  it('reports which permission was missing, with a machine-readable code', () => {
    const guard = guardRequiring(PERMISSIONS.ACCOUNTS_OPENING_BALANCE);
    try {
      guard.canActivate(contextFor({ role: 'MANAGER' }));
      throw new Error('expected a ForbiddenException');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = err.getResponse();
      expect(body.code).toBe('INSUFFICIENT_PERMISSION');
      expect(body.requiredPermission).toBe(PERMISSIONS.ACCOUNTS_OPENING_BALANCE);
      expect(body.message).toContain(PERMISSIONS.ACCOUNTS_OPENING_BALANCE);
    }
  });

  it('reads the role off the request, not off the JWT payload', () => {
    // jwt.strategy.ts replaces the token's role with the current membership
    // role before this guard runs; the guard must honour whatever ends up
    // on request.user rather than re-deriving anything itself.
    const guard = guardRequiring(PERMISSIONS.INVENTORY_ADJUST);
    expect(() =>
      guard.canActivate(contextFor({ role: 'STAFF', token: { role: 'OWNER' } })),
    ).toThrow(ForbiddenException);
  });
});
