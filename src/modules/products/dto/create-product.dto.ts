import { UnitType } from '../../../common/enums';
﻿import { IsString, IsNotEmpty, IsOptional, IsNumber, IsArray, IsEnum, ValidateNested, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
;

export class FreshnessProfileDto {
  @ApiProperty({ example: 0 })
  @IsNumber()
  dayOffset!: number;

  @ApiProperty({ example: 100 })
  @IsNumber()
  @Min(0)
  qualityPct!: number;

  @ApiProperty({ example: 'FRESH' })
  @IsString()
  status!: string;

  @ApiPropertyOptional({ example: 1.0 })
  @IsOptional()
  @IsNumber()
  priceMultiplier?: number;
}

export class CreateProductDto {
  @ApiProperty({ example: 'Apple' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'Fuji' })
  @IsOptional()
  @IsString()
  variety?: string;

  @ApiPropertyOptional({ example: 'A' })
  @IsOptional()
  @IsString()
  grade?: string;

  @ApiPropertyOptional({ example: 'Fruits' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ enum: UnitType, example: UnitType.KG })
  @IsEnum(UnitType)
  primaryUnit!: UnitType;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @IsNumber()
  defaultBoxWeightKg?: number;

  @ApiPropertyOptional({ example: 18 })
  @IsOptional()
  @IsNumber()
  weightRangeMinKg?: number;

  @ApiPropertyOptional({ example: 22 })
  @IsOptional()
  @IsNumber()
  weightRangeMaxKg?: number;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber()
  shelfLifeDays?: number;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber()
  defaultMarkupPct?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  minMarginPct?: number;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @IsNumber()
  reorderThreshold?: number;

  @ApiPropertyOptional({ example: 200 })
  @IsOptional()
  @IsNumber()
  reorderQty?: number;

  @ApiPropertyOptional({ example: 'Keep refrigerated' })
  @IsOptional()
  @IsString()
  storageNotes?: string;

  @ApiPropertyOptional({ type: [FreshnessProfileDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FreshnessProfileDto)
  freshnessProfile?: FreshnessProfileDto[];
}
