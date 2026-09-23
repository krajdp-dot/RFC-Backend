import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../../common/enums.js';
import { ASSIGNABLE_ROLES } from '../auth/authorization/permissions.js';

function sanitizeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async create(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data,
    });
  }

  /**
   * Phase 10 — user management. Flat queries + in-memory join (not
   * `include`) for the same testability reason as every other Phase 7-9
   * fix in this codebase.
   */
  async listMembers(businessId: string) {
    const memberships = await this.prisma.userBusiness.findMany({ where: { businessId } });
    const userIds = memberships.map((m: any) => m.userId);
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } } })
      : [];
    const userById = new Map<string, any>(users.map((u: any) => [u.id, u]));

    return memberships.map((m: any) => {
      const user = userById.get(m.userId);
      return {
        membershipId: m.id,
        userId: m.userId,
        name: user?.name,
        email: user?.email,
        phone: user?.phone,
        role: m.role,
        active: !m.disabledAt,
        disabledAt: m.disabledAt,
        createdAt: m.createdAt,
      };
    });
  }

  /**
   * Adds someone to a business — either a brand-new account (email not
   * seen before) or an existing one gaining a second business membership.
   * Section 24/25: no email-delivery system exists in this codebase, so
   * this is the secure backend foundation only (creates the account and
   * membership directly with the given password) rather than inventing an
   * email provider or a token-based invite flow that has nowhere to
   * deliver its link — documented as a real limitation in the Phase 10
   * report, not silently worked around.
   */
  async inviteMember(
    businessId: string,
    dto: { email: string; name: string; phone?: string; password: string; role: string },
    actingUserId: string,
    actingUserRole: string,
  ) {
    if (!ASSIGNABLE_ROLES.includes(dto.role as any)) {
      throw new ForbiddenException({ message: `Unknown role '${dto.role}'`, code: 'INVALID_ROLE' });
    }
    // Defense in depth: the controller route already requires
    // users.invite, which only OWNER holds in this permission model — but
    // checking again here means this still holds even if that mapping
    // ever changes, per Section 24: "Do not allow a normal manager to
    // create an OWNER."
    if (dto.role === 'OWNER' && actingUserRole !== 'OWNER') {
      throw new ForbiddenException({ message: 'Only an owner can grant the OWNER role', code: 'INSUFFICIENT_PERMISSION' });
    }

    let user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      const passwordHash = await bcrypt.hash(dto.password, 10);
      user = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, phone: dto.phone, passwordHash },
      });
    }

    const existingMembership = await this.prisma.userBusiness.findFirst({
      where: { userId: user.id, businessId },
    });
    if (existingMembership) {
      throw new ConflictException('This person already has access to this business');
    }

    const membership = await this.prisma.userBusiness.create({
      data: { userId: user.id, businessId, role: dto.role, invitedBy: actingUserId },
    });

    await this.auditService.recordStandalone({
      businessId,
      userId: actingUserId,
      action: AuditAction.CREATE,
      entityType: 'USER_BUSINESS',
      entityId: membership.id,
      after: { email: dto.email, role: dto.role },
    });

    return { membershipId: membership.id, user: sanitizeUser(user), role: membership.role };
  }

  async changeRole(
    businessId: string,
    membershipId: string,
    newRole: string,
    actingUserId: string,
    actingUserRole: string,
  ) {
    if (!ASSIGNABLE_ROLES.includes(newRole as any)) {
      throw new ForbiddenException({ message: `Unknown role '${newRole}'`, code: 'INVALID_ROLE' });
    }

    const membership = await this.prisma.userBusiness.findFirst({ where: { id: membershipId, businessId } });
    if (!membership) throw new NotFoundException('Membership not found');

    // Section 24: "A user must not be able to modify their own permissions
    // beyond what their role allows" — simplest correct rule is that a
    // role change can never target yourself, full stop, regardless of
    // direction (this also blocks the specific escalation case, but is
    // deliberately broader than just that).
    if (membership.userId === actingUserId) {
      throw new ForbiddenException({ message: 'You cannot change your own role', code: 'INSUFFICIENT_PERMISSION' });
    }
    if (newRole === 'OWNER' && actingUserRole !== 'OWNER') {
      throw new ForbiddenException({ message: 'Only an owner can grant the OWNER role', code: 'INSUFFICIENT_PERMISSION' });
    }

    if (membership.role === 'OWNER' && newRole !== 'OWNER') {
      await this.assertNotLastActiveOwner(businessId, membership.id);
    }

    const updated = await this.prisma.userBusiness.update({
      where: { id: membershipId },
      data: { role: newRole },
    });

    await this.auditService.recordStandalone({
      businessId,
      userId: actingUserId,
      action: AuditAction.UPDATE,
      entityType: 'USER_BUSINESS',
      entityId: membershipId,
      before: { role: membership.role },
      after: { role: newRole },
    });

    return { membershipId: updated.id, role: updated.role };
  }

  async setDisabled(
    businessId: string,
    membershipId: string,
    disabled: boolean,
    actingUserId: string,
  ) {
    const membership = await this.prisma.userBusiness.findFirst({ where: { id: membershipId, businessId } });
    if (!membership) throw new NotFoundException('Membership not found');

    if (membership.userId === actingUserId) {
      throw new ForbiddenException({ message: 'You cannot disable your own access', code: 'INSUFFICIENT_PERMISSION' });
    }
    if (disabled && membership.role === 'OWNER') {
      await this.assertNotLastActiveOwner(businessId, membership.id);
    }

    const updated = await this.prisma.userBusiness.update({
      where: { id: membershipId },
      data: { disabledAt: disabled ? new Date() : null },
    });

    await this.auditService.recordStandalone({
      businessId,
      userId: actingUserId,
      action: AuditAction.UPDATE,
      entityType: 'USER_BUSINESS',
      entityId: membershipId,
      before: { disabledAt: membership.disabledAt },
      after: { disabledAt: updated.disabledAt },
    });

    return { membershipId: updated.id, active: !updated.disabledAt };
  }

  /**
   * Section 24: "Do not accidentally create a system where the final
   * owner can lock themselves out." Every business must keep at least one
   * active OWNER at all times — checked before demoting or disabling one.
   */
  private async assertNotLastActiveOwner(businessId: string, excludingMembershipId: string) {
    const owners = await this.prisma.userBusiness.findMany({
      where: { businessId, role: 'OWNER' },
    });
    const otherActiveOwners = owners.filter((o: any) => o.id !== excludingMembershipId && !o.disabledAt);
    if (otherActiveOwners.length === 0) {
      throw new ForbiddenException({
        message: 'This business must have at least one active owner',
        code: 'LAST_OWNER_PROTECTED',
      });
    }
  }
}
