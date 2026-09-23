import { PaymentMethod } from '../../../common/enums.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RefundCustomerDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  customerId: string;

  @ApiProperty({ description: 'The sale this refund is against — required, a refund must be linked to a sale' })
  @IsString()
  @IsNotEmpty()
  saleId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  amount: string;

  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  @IsNotEmpty()
  method: PaymentMethod;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  accountId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  businessDate: string;

  @ApiProperty({ description: 'Why this refund is being made — required' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Client-supplied key — a retry with the same key returns the original result instead of creating a duplicate refund' })
  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
