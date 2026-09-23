import { UnitType, QualityGrade, PaymentMethod } from '../../../common/enums';
﻿import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
;

export class PurchaseItemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  productId: string;

  @ApiProperty()
  @IsNumber()
  @IsNotEmpty()
  quantityBoxes: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  totalNetWeightKg?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  ratePerUnit: string;

  @ApiProperty({ enum: UnitType })
  @IsEnum(UnitType)
  @IsNotEmpty()
  unit: UnitType;

  @ApiPropertyOptional({ enum: QualityGrade })
  @IsEnum(QualityGrade)
  @IsOptional()
  quality?: QualityGrade;
}

export class PurchasePaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  method: PaymentMethod;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  amount: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;
}

export class CreatePurchaseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  supplierId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessDate: string;

  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items: PurchaseItemDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  transport?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  loading?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  unloading?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  otherCosts?: string;

  @ApiProperty({ type: [PurchasePaymentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchasePaymentDto)
  payments: PurchasePaymentDto[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
