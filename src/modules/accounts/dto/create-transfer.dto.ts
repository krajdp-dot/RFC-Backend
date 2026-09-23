import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTransferDto {
  @ApiProperty({ example: 'acc_123' })
  @IsString()
  fromAccountId: string;

  @ApiProperty({ example: 'acc_456' })
  @IsString()
  toAccountId: string;

  @ApiProperty({ example: '5000.00' })
  @IsString()
  amount: string;

  @ApiProperty({ example: '2023-10-27T00:00:00.000Z' })
  @IsDateString()
  businessDate: string;

  @ApiPropertyOptional({ example: 'Transfer to petty cash' })
  @IsString()
  @IsOptional()
  notes?: string;
}
