import { SetMetadata } from '@nestjs/common';
import { Permission } from './permissions.js';

export const PERMISSION_KEY = 'requiredPermission';

/**
 * @RequirePermission('sales.return') on a controller method — checked by
 * PermissionsGuard (registered globally in app.module.ts, same pattern as
 * JwtAuthGuard + the @Public() decorator). A route with no
 * @RequirePermission() is unaffected by this guard entirely — see the
 * Phase 10 report for which routes have been annotated in this pass and
 * which are deliberately left for a follow-up.
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(PERMISSION_KEY, permission);
