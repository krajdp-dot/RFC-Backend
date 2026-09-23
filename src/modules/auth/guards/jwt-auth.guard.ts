import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator.js';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Phase 10: this guard previously had an "auth-disabled dev mode" that
    // fully bypassed authentication — triggered by either AUTH_DISABLED=true
    // or JWT_SECRET being literally the string 'dev-secret' — and on
    // trigger, injected a request.user for whichever business existed first
    // in the database (auto-creating one if none did) with zero
    // credentials checked. That is a live authentication bypass, not a
    // dev convenience: nothing in this codebase's .env.example advertises
    // AUTH_DISABLED, so it was also undocumented — a hidden trap rather
    // than an opt-in tool. A secure path to a working local session already
    // exists (prisma/seed.ts creates a real user with a real bcrypt-hashed
    // password, logged in through this exact endpoint normally), so the
    // bypass had no remaining purpose. Removed outright rather than merely
    // gating it further (e.g. behind NODE_ENV) — see the Phase 10 report
    // for the full reasoning.
    const result = super.canActivate(context);
    if (result instanceof Promise) {
      return result as Promise<boolean>;
    }
    return result as boolean;
  }
}
