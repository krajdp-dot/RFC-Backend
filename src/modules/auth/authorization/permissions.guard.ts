import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from './require-permission.decorator.js';
import { roleHasPermission, Permission } from './permissions.js';

/**
 * Registered globally (app.module.ts), same layering as JwtAuthGuard: that
 * guard runs first and populates request.user (userId, businessId, role —
 * role read fresh from the current UserBusiness membership, not trusted
 * from the token — see jwt.strategy.ts). This guard only ever narrows
 * further; it never substitutes for @CurrentBusiness()'s own scoping, and
 * a route with no @RequirePermission() passes through untouched.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const role: string | undefined = request.user?.role;

    if (!role || !roleHasPermission(role, required)) {
      throw new ForbiddenException({
        message: `This action requires the '${required}' permission.`,
        code: 'INSUFFICIENT_PERMISSION',
        requiredPermission: required,
      });
    }

    return true;
  }
}
