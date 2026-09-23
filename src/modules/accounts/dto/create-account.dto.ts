import { AccountType } from '../../../common/enums';
﻿import { IsString, IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
;

export class CreateAccountDto {
  @ApiProperty({ example: 'HDFC Current Account' })
  @IsString()
  name: string;

  @ApiProperty({ enum: AccountType, example: AccountType.BANK })
  @IsEnum(AccountType)
  type: AccountType;

  @ApiPropertyOptional({ example: '10000.00' })
  @IsString()
  @IsOptional()
  openingBalance?: string;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}
