import { IsString, IsOptional, IsBoolean, IsUUID, MinLength, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendCustomMessageDto {
  @ApiProperty({ example: 'Your order will be ready for pickup by 5pm today.' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  content: string;

  // Same pattern as Sale/Payment's idempotencyKey (Phase 9/11) — a
  // client-generated id that survives retries, so a double-tap on Send
  // can't produce two messages (section 30).
  @ApiProperty({ example: 'b3f1c2e4-...' })
  @IsString()
  @IsUUID()
  mutationId: string;
}

export class SendStatementDto {
  @ApiPropertyOptional({ example: 'b3f1c2e4-...', description: 'Same idea as SendCustomMessageDto.mutationId — a client-generated id so a double-tap on Send is deduplicated reliably.' })
  @IsString()
  @IsUUID()
  @IsOptional()
  mutationId?: string;
}

export class SetOptInDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  optIn: boolean;
}

export class UpdateAutomationSettingsDto {
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  saleConfirmationEnabled?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  paymentReceiptEnabled?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  outstandingReminderEnabled?: boolean;
}
