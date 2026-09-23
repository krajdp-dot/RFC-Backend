import { PaymentMethod } from '../../../common/enums';
﻿import { IsString, IsOptional, IsDateString, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
;

export class CreateExpenseDto {
  @ApiProperty({ example: 'cat_123' })
  @IsString()
  categoryId: string;

  @ApiProperty({ example: 'Transport from Nashik' })
  @IsString()
  description: string;

  @ApiProperty({ example: '2500.00' })
  @IsString()
  amount: string;

  @ApiProperty({ example: 'acc_123' })
  @IsString()
  accountId: string;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;

  @ApiProperty({ example: '2023-10-27T00:00:00.000Z' })
  @IsDateString()
  businessDate: string;

  @ApiPropertyOptional({ example: 'Raju Transports' })
  @IsString()
  @IsOptional()
  payee?: string;

  @ApiPropertyOptional({ example: 'Invoice #456' })
  @IsString()
  @IsOptional()
  notes?: string;
}
