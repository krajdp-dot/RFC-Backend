import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsDateString } from 'class-validator';

export class CashReconciliationDto {
  @ApiProperty()
  @IsString()
  accountId: string;

  @ApiProperty()
  @IsNumber()
  physicalAmount: number;

  @ApiProperty()
  @IsDateString()
  businessDate: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}

export class InventoryReconciliationDto {
  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNumber()
  physicalBoxes: number;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  physicalWeightKg?: number;

  @ApiProperty()
  @IsDateString()
  businessDate: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
