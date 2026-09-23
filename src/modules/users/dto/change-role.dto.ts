import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ASSIGNABLE_ROLES } from '../../auth/authorization/permissions.js';

export class ChangeRoleDto {
  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role: string;
}
