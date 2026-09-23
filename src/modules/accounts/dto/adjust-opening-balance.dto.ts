import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AdjustOpeningBalanceDto {
  @ApiProperty({ description: 'New opening balance for the account', example: '15000.00' })
  @IsString()
  @IsNotEmpty()
  amount: string;

  @ApiProperty({ description: 'Why the opening balance is being changed — required for the audit trail' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
