import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateBoxDto {
  @ApiProperty({ example: 'LOT-UUID', description: 'Lot ID' })
  @IsString()
  @IsNotEmpty()
  lotId: string;

  @ApiPropertyOptional({ example: '15.5', description: 'Weight in kg' })
  @IsString()
  @IsOptional()
  weightKg?: string;

  @ApiPropertyOptional({ example: 'RFID-12345', description: 'Box label or RFID tag' })
  @IsString()
  @IsOptional()
  label?: string;
}
