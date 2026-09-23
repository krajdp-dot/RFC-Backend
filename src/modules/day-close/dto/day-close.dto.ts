import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateDayCloseDto {
  @ApiPropertyOptional({
    description: 'Business date to close, YYYY-MM-DD. Defaults to today (business timezone) if omitted.',
    example: '2026-09-06',
  })
  @IsString()
  @IsOptional()
  businessDate?: string;

  @ApiPropertyOptional({ description: 'Actual physical cash counted at close' })
  @IsNumber()
  @IsOptional()
  physicalCash?: number;

  @ApiPropertyOptional({ description: 'Notes, e.g. explaining a cash variance' })
  @IsString()
  @IsOptional()
  notes?: string;
}
