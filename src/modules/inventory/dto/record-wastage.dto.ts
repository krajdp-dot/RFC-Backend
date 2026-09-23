import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID } from 'class-validator';

export class RecordWastageDto {
  @ApiProperty({ example: 'LOT-UUID', description: 'Lot ID for wastage' })
  @IsString()
  @IsNotEmpty()
  lotId: string;

  @ApiPropertyOptional({ example: 2, description: 'Number of boxes wasted' })
  @IsNumber()
  @IsOptional()
  quantityBoxes?: number;

  @ApiPropertyOptional({ example: '5.5', description: 'Weight wasted in kg' })
  @IsString()
  @IsOptional()
  weightKg?: string;

  @ApiProperty({ example: 'Rotten apples', description: 'Reason for wastage' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ example: '2026-09-07', description: 'Business date the wastage applies to. Defaults to today (business timezone) if omitted.' })
  @IsString()
  @IsOptional()
  businessDate?: string;
}
