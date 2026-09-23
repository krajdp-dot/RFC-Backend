import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { InviteMemberDto } from './dto/invite-member.dto.js';
import { ChangeRoleDto } from './dto/change-role.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS, permissionsForRole, ASSIGNABLE_ROLES } from '../auth/authorization/permissions.js';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List this business's members" })
  @RequirePermission(PERMISSIONS.USERS_VIEW)
  listMembers(@CurrentBusiness() businessId: string) {
    return this.usersService.listMembers(businessId);
  }

  @Post()
  @ApiOperation({ summary: 'Add a member to this business (creates the account if the email is new)' })
  @RequirePermission(PERMISSIONS.USERS_INVITE)
  inviteMember(
    @CurrentBusiness() businessId: string,
    @Body() dto: InviteMemberDto,
    @CurrentUser('userId') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.usersService.inviteMember(businessId, dto, userId, role);
  }

  @Put(':membershipId/role')
  @ApiOperation({ summary: "Change a member's role" })
  @RequirePermission(PERMISSIONS.USERS_EDIT)
  changeRole(
    @CurrentBusiness() businessId: string,
    @Param('membershipId') membershipId: string,
    @Body() dto: ChangeRoleDto,
    @CurrentUser('userId') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.usersService.changeRole(businessId, membershipId, dto.role, userId, role);
  }

  @Put(':membershipId/disable')
  @ApiOperation({ summary: "Revoke a member's access to this business" })
  @RequirePermission(PERMISSIONS.USERS_DISABLE)
  disableMember(
    @CurrentBusiness() businessId: string,
    @Param('membershipId') membershipId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.usersService.setDisabled(businessId, membershipId, true, userId);
  }

  @Put(':membershipId/enable')
  @ApiOperation({ summary: "Restore a member's access to this business" })
  @RequirePermission(PERMISSIONS.USERS_DISABLE)
  enableMember(
    @CurrentBusiness() businessId: string,
    @Param('membershipId') membershipId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.usersService.setDisabled(businessId, membershipId, false, userId);
  }

  @Get('roles')
  @ApiOperation({ summary: 'The permission matrix for each assignable role' })
  @RequirePermission(PERMISSIONS.ROLES_VIEW)
  listRoles() {
    return ASSIGNABLE_ROLES.map((role) => ({ role, permissions: permissionsForRole(role) }));
  }
}
