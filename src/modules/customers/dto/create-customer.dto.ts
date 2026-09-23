import { IsString, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCustomerDto {
  @ApiProperty({ example: 'Ramesh Singh' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ example: '123 Market Rd, Azadpur' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ example: 'Ramesh Trading Co.' })
  @IsString()
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional({ example: '50000.00' })
  @IsString()
  @IsOptional()
  creditLimit?: string;

  @ApiPropertyOptional({ example: 15 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  creditTermsDays?: number;

  @ApiPropertyOptional({ example: 'VIP customer' })
  @IsString()
  @IsOptional()
  notes?: string;

  // Phase 12: only set when WhatsApp differs from `phone` — most
  // customers won't need this filled in at all. See
  // docs/PHASE-12-WHATSAPP.md, "Customer identity".
  @ApiPropertyOptional({ example: '+919876543210', description: 'Only if different from the phone number above' })
  @IsString()
  @IsOptional()
  whatsappNumber?: string;
}
