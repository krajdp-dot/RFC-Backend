import { UnitType, PaymentMethod } from '../../../common/enums';
﻿import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
;

export class SaleItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  quantity: number;

  @ApiProperty({ enum: UnitType })
  @IsEnum(UnitType)
  @IsNotEmpty()
  unit: UnitType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  rate: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  weightKg?: string;
}

export class SalePaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  method: PaymentMethod;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  amount: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  accountId?: string;
}

export class CreateSaleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessDate: string;

  @ApiProperty({ type: [SaleItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  discount?: string;

  @ApiProperty({ type: [SalePaymentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments: SalePaymentDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
