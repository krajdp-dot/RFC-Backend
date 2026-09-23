import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

/**
 * Phase 10, Section 24 — the rules that stop user management from being a
 * privilege-escalation surface or a way to lock a business out of itself.
 */
describe('UsersService — Phase 10 member management', () => {
  let usersService: UsersService;
  let fakePrisma: FakePrismaService;

  const OWNER_USER = 'user_owner';
  const MANAGER_USER = 'user_manager';
  const STAFF_USER = 'user_staff';

  async function build() {
    fakePrisma = new FakePrismaService({
      user: [
        { id: OWNER_USER, email: 'owner@rfc.test', name: 'Owner', passwordHash: 'hash', active: true },
        { id: MANAGER_USER, email: 'manager@rfc.test', name: 'Manager', passwordHash: 'hash', active: true },
        { id: STAFF_USER, email: 'staff@rfc.test', name: 'Staff', passwordHash: 'hash', active: true },
        // Has an account already, but no membership of biz_1 yet.
        { id: 'user_existing', email: 'existing@rfc.test', name: 'Existing', passwordHash: 'hash', active: true },
      ],
      userBusiness: [
        { id: 'mem_owner', userId: OWNER_USER, businessId: 'biz_1', role: 'OWNER', createdAt: new Date(), disabledAt: null },
        { id: 'mem_manager', userId: MANAGER_USER, businessId: 'biz_1', role: 'MANAGER', createdAt: new Date(), disabledAt: null },
        { id: 'mem_staff', userId: STAFF_USER, businessId: 'biz_1', role: 'STAFF', createdAt: new Date(), disabledAt: null },
        { id: 'mem_other_biz', userId: STAFF_USER, businessId: 'biz_2', role: 'OWNER', createdAt: new Date(), disabledAt: null },
      ],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    usersService = moduleRef.get(UsersService);
  }

  beforeEach(async () => {
    await build();
  });

  describe('listMembers', () => {
    it('returns only this business, joined to user details, without password hashes', async () => {
      const members = await usersService.listMembers('biz_1');
      expect(members).toHaveLength(3);
      expect(members.map((m: any) => m.role).sort()).toEqual(['MANAGER', 'OWNER', 'STAFF']);
      expect(members.every((m: any) => m.email)).toBe(true);
      expect(JSON.stringify(members)).not.toContain('passwordHash');
    });

    it('reports a disabled membership as inactive rather than hiding it', async () => {
      await usersService.setDisabled('biz_1', 'mem_staff', true, OWNER_USER);
      const members = await usersService.listMembers('biz_1');
      const staff = members.find((m: any) => m.membershipId === 'mem_staff');
      expect(staff.active).toBe(false);
      expect(staff.disabledAt).toBeTruthy();
    });
  });

  describe('inviteMember', () => {
    const newMember = { email: 'new@rfc.test', name: 'New Hire', password: 'correct horse battery', role: 'STAFF' };

    it('creates the account and the membership, recording who invited them', async () => {
      const result = await usersService.inviteMember('biz_1', newMember, OWNER_USER, 'OWNER');
      expect(result.role).toBe('STAFF');

      const membership = await fakePrisma.userBusiness.findFirst({ where: { id: result.membershipId } });
      expect(membership.businessId).toBe('biz_1');
      expect(membership.invitedBy).toBe(OWNER_USER);

      const created = await fakePrisma.user.findFirst({ where: { email: 'new@rfc.test' } });
      expect(created.passwordHash).not.toBe('correct horse battery');
      expect(created.passwordHash.startsWith('$2')).toBe(true);
    });

    it('never returns the password hash to the caller', async () => {
      const result = await usersService.inviteMember('biz_1', newMember, OWNER_USER, 'OWNER');
      expect(result.user.passwordHash).toBeUndefined();
      expect(result.user.email).toBe('new@rfc.test');
    });

    it('adds a second business to an existing account instead of creating a duplicate user', async () => {
      const before = fakePrisma._tables().user.length;
      const result = await usersService.inviteMember(
        'biz_1',
        { ...newMember, email: 'existing@rfc.test' },
        OWNER_USER,
        'OWNER',
      );
      expect(fakePrisma._tables().user).toHaveLength(before);
      const membership = await fakePrisma.userBusiness.findFirst({ where: { id: result.membershipId } });
      expect(membership.userId).toBe('user_existing');
    });

    it('rejects someone who already has access to this business', async () => {
      await expect(
        usersService.inviteMember('biz_1', { ...newMember, email: 'staff@rfc.test' }, OWNER_USER, 'OWNER'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an unknown role', async () => {
      await expect(
        usersService.inviteMember('biz_1', { ...newMember, role: 'SUPERUSER' }, OWNER_USER, 'OWNER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only an OWNER can create another OWNER', async () => {
      await expect(
        usersService.inviteMember('biz_1', { ...newMember, role: 'OWNER' }, MANAGER_USER, 'MANAGER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        usersService.inviteMember('biz_1', { ...newMember, role: 'OWNER' }, OWNER_USER, 'OWNER'),
      ).resolves.toBeDefined();
    });

    it('writes an audit entry', async () => {
      await usersService.inviteMember('biz_1', newMember, OWNER_USER, 'OWNER');
      const audit = fakePrisma._tables().auditLog;
      expect(audit).toHaveLength(1);
      expect(audit[0].entityType).toBe('USER_BUSINESS');
      expect(audit[0].userId).toBe(OWNER_USER);
    });
  });

  describe('changeRole', () => {
    it('updates the role and audits the before/after', async () => {
      const result = await usersService.changeRole('biz_1', 'mem_staff', 'MANAGER', OWNER_USER, 'OWNER');
      expect(result.role).toBe('MANAGER');

      const audit = fakePrisma._tables().auditLog;
      expect(audit).toHaveLength(1);
      expect(audit[0].before.role).toBe('STAFF');
      expect(audit[0].after.role).toBe('MANAGER');
    });

    it('refuses to change your own role in either direction', async () => {
      await expect(
        usersService.changeRole('biz_1', 'mem_owner', 'STAFF', OWNER_USER, 'OWNER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        usersService.changeRole('biz_1', 'mem_manager', 'OWNER', MANAGER_USER, 'MANAGER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only an OWNER can promote someone to OWNER', async () => {
      await expect(
        usersService.changeRole('biz_1', 'mem_staff', 'OWNER', MANAGER_USER, 'MANAGER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects an unknown role', async () => {
      await expect(
        usersService.changeRole('biz_1', 'mem_staff', 'ADMIN', OWNER_USER, 'OWNER'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cannot reach a membership belonging to another business', async () => {
      await expect(
        usersService.changeRole('biz_1', 'mem_other_biz', 'STAFF', OWNER_USER, 'OWNER'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to demote the last active owner', async () => {
      // A second owner exists only after being promoted, so demoting the
      // original must fail first and succeed after.
      await expect(
        usersService.changeRole('biz_1', 'mem_owner', 'MANAGER', MANAGER_USER, 'MANAGER'),
      ).rejects.toMatchObject({ response: { code: 'LAST_OWNER_PROTECTED' } });

      await usersService.changeRole('biz_1', 'mem_manager', 'OWNER', OWNER_USER, 'OWNER');
      await expect(
        usersService.changeRole('biz_1', 'mem_owner', 'MANAGER', MANAGER_USER, 'MANAGER'),
      ).resolves.toMatchObject({ role: 'MANAGER' });
    });

    it('a disabled owner does not count towards the last-owner check', async () => {
      await usersService.changeRole('biz_1', 'mem_manager', 'OWNER', OWNER_USER, 'OWNER');
      await usersService.setDisabled('biz_1', 'mem_manager', true, OWNER_USER);
      await expect(
        usersService.changeRole('biz_1', 'mem_owner', 'STAFF', MANAGER_USER, 'MANAGER'),
      ).rejects.toMatchObject({ response: { code: 'LAST_OWNER_PROTECTED' } });
    });
  });

  describe('setDisabled', () => {
    it('revokes and restores access, auditing both', async () => {
      const off = await usersService.setDisabled('biz_1', 'mem_staff', true, OWNER_USER);
      expect(off.active).toBe(false);

      const on = await usersService.setDisabled('biz_1', 'mem_staff', false, OWNER_USER);
      expect(on.active).toBe(true);

      expect(fakePrisma._tables().auditLog).toHaveLength(2);
    });

    it('refuses to disable yourself', async () => {
      await expect(
        usersService.setDisabled('biz_1', 'mem_owner', true, OWNER_USER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses to disable the last active owner', async () => {
      await expect(
        usersService.setDisabled('biz_1', 'mem_owner', true, MANAGER_USER),
      ).rejects.toMatchObject({ response: { code: 'LAST_OWNER_PROTECTED' } });
    });

    it('cannot reach a membership belonging to another business', async () => {
      await expect(
        usersService.setDisabled('biz_1', 'mem_other_biz', true, OWNER_USER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
