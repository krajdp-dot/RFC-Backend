import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { userId: string; email: string; businessId: string; role: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException('User is not active or does not exist');
    }

    // Phase 10: role (and implicitly, whether the membership still exists
    // at all) used to come straight from the token's own payload — baked
    // in once at login and never re-checked. That means revoking a
    // membership, disabling it, or changing someone's role had no effect
    // on any token already issued until it naturally expired (up to
    // JWT_EXPIRY). Re-reading it from the database on every request costs
    // one extra indexed lookup and makes a revoked/changed membership take
    // effect immediately, which matters more here than the lookup cost.
    const membership = await this.prisma.userBusiness.findFirst({
      where: { userId: payload.userId, businessId: payload.businessId },
    });
    if (!membership || membership.disabledAt) {
      throw new UnauthorizedException('Business access revoked');
    }

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      businessId: payload.businessId,
      role: membership.role,
    };
  }
}
