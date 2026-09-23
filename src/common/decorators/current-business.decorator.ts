import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

/**
 * Extract the current businessId from the authenticated user's JWT.
 * Usage: @CurrentBusiness() businessId: string
 */
export const CurrentBusiness = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    if (!request.user || !request.user.businessId) {
      throw new UnauthorizedException('Business context is required');
    }
    return request.user.businessId;
  },
);
