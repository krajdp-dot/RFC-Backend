import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CreateManualReferenceDto {
  @ApiProperty()
  @IsString()
  productId: string;

  @ApiProperty()
  @IsNumber()
  marketPrice: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
