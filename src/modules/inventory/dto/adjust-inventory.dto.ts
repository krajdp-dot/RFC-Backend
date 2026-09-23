import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export class AdjustInventoryDto {
  @ApiProperty({ example: 'LOT-UUID', description: 'Lot ID to adjust' })
  @IsString()
  @IsNotEmpty()
  lotId: string;

  @ApiPropertyOptional({ example: 5, description: 'Number of boxes to add/remove (use negative for removal)' })
  @IsNumber()
  @IsOptional()
  quantityBoxes?: number;

  @ApiPropertyOptional({ example: '10.5', description: 'Weight to add/remove in kg (use negative for removal)' })
  @IsString()
  @IsOptional()
  weightKg?: string;

  @ApiProperty({ example: 'Found extra boxes in warehouse', description: 'Reason for adjustment' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ example: '2026-09-07', description: 'Business date the adjustment applies to. Defaults to today (business timezone) if omitted.' })
  @IsString()
  @IsOptional()
  businessDate?: string;
}
