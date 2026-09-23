import { IsString, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSupplierDto {
  @ApiProperty({ example: 'Suresh Kumar' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '+919876543211' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: '456 Farm Rd, Nashik' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: 'Suresh Farms' })
  @IsString()
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({ example: 30 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  paymentTermsDays?: number;

  @ApiPropertyOptional({ example: 'Reliable grape supplier' })
  @IsString()
  @IsOptional()
  notes?: string;
}
