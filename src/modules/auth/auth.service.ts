import { UserRole, AccountType } from '../../common/enums.js';
import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { permissionsForRole } from './authorization/permissions.js';
import * as bcrypt from 'bcrypt';

// Phase 10: register() and login() both used to return the raw user row
// straight from Prisma — which includes passwordHash — directly in the API
// response body (`user: result.user` / `user`). Every response now goes
// through this first.
function sanitizeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      // Create user
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash: hashedPassword,
          name: dto.name,
          phone: dto.phone,
        },
      });

      // Create business
      const business = await tx.business.create({
        data: {
          name: dto.businessName,
          // create UserBusiness relation
          users: {
            create: {
              userId: user.id,
              role: UserRole.OWNER,
            },
          },
        },
      });

      // Create default accounts
      await tx.account.createMany({
        data: [
          { name: 'Cash Galla', type: AccountType.CASH, businessId: business.id },
          { name: 'SBI', type: AccountType.BANK, businessId: business.id },
          { name: 'PNB', type: AccountType.BANK, businessId: business.id },
          { name: 'UPI PhonePe', type: AccountType.DIGITAL, businessId: business.id },
        ],
      });

      // Create default expense categories
      const categories = ['Transport', 'Labour', 'Loading', 'Unloading', 'Rent', 'Electricity', 'Fuel', 'Packaging', 'Phone', 'Repairs', 'Commission', 'Market Charges', 'Bank Charges', 'Other'];
      await tx.expenseCategory.createMany({
        data: categories.map(name => ({
          name,
          businessId: business.id,
        })),
      });

      return { user, business };
    });

    const token = this.jwtService.sign({
      userId: result.user.id,
      email: result.user.email,
      businessId: result.business.id,
      role: UserRole.OWNER,
    });

    return {
      token,
      user: sanitizeUser(result.user),
      business: result.business,
    };
  }

  async login(dto: LoginDto) {
    // Flat queries instead of `include: { businesses: true }` — consistent
    // with the rest of this codebase's testable-against-the-fake-double
    // convention (see receivables/payables/expenses/freshness services
    // from earlier phases for the same fix, for the same reason).
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    // Section 8: don't let a login attempt reveal whether an email exists —
    // same message and control flow whether the account is missing or the
    // password is simply wrong.
    if (!user || !user.active) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const memberships = await this.prisma.userBusiness.findMany({ where: { userId: user.id } });
    const active = memberships.filter((m: any) => !m.disabledAt);
    if (active.length === 0) {
      // Section 24: a real, distinct failure — the credentials are correct
      // but there is no business left to sign into (every membership was
      // disabled, or none was ever created for this account) — not the
      // same as "wrong password", and previously this silently issued a
      // working token with businessId: '' instead of failing.
      throw new UnauthorizedException('No active business access for this account');
    }
    const primary = active[0];

    const token = this.jwtService.sign({
      userId: user.id,
      email: user.email,
      businessId: primary.businessId,
      role: primary.role,
    });

    const business = await this.prisma.business.findUnique({ where: { id: primary.businessId } });

    return {
      token,
      user: sanitizeUser(user),
      business,
      // Section 11/32: lets the frontend know up front whether there's
      // more than one business to offer a switcher for, without a second
      // round trip — full switching UI is out of scope for this pass (see
      // the Phase 10 report), but the data needed for it is here.
      memberships: active.map((m: any) => ({ businessId: m.businessId, role: m.role })),
    };
  }

  /**
   * Section 10: GET /auth/me should return enough for the frontend to
   * initialize safely — including permissions, so it isn't guessing at
   * what the role string implies (Section 11: "Do not make the frontend
   * guess the user's role from display names"). Built from the
   * already-fresh req.user (jwt.strategy.ts re-reads the membership every
   * request), not from anything cached.
   */
  async getMe(userId: string, businessId: string, role: string) {
    const [user, business, memberships] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.business.findUnique({ where: { id: businessId } }),
      this.prisma.userBusiness.findMany({ where: { userId } }),
    ]);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return {
      ...sanitizeUser(user),
      business,
      role,
      permissions: permissionsForRole(role),
      memberships: memberships
        .filter((m: any) => !m.disabledAt)
        .map((m: any) => ({ businessId: m.businessId, role: m.role })),
    };
  }
}
