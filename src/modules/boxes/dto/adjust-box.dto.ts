import { BoxStatus } from '../../../common/enums';
﻿import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
;

export class AdjustBoxDto {
  @ApiPropertyOptional({ enum: BoxStatus })
  @IsEnum(BoxStatus)
  @IsOptional()
  status?: BoxStatus;

  @ApiPropertyOptional({ example: '14.5' })
  @IsString()
  @IsOptional()
  weightKg?: string;
}
