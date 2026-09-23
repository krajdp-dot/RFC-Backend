import { Controller, Get, Post, Put, Param, Body, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WhatsAppService } from './whatsapp.service.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { SendCustomMessageDto, SendStatementDto, SetOptInDto, UpdateAutomationSettingsDto } from './dto/whatsapp.dto.js';

/**
 * Phase 12, section 31 — a tighter, WhatsApp-specific throttle than the
 * app-wide default (100/min), directly on the endpoints that create a
 * message: "one accidental button loop" is stopped here, before a
 * message ever reaches QUEUED, rather than relying only on the worker's
 * own batch cap (whatsapp-queue.processor.ts).
 */
const SEND_THROTTLE = { default: { limit: 20, ttl: 60000 } };

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  // ---- Sends (section 19-21, 38) -----------------------------------------

  @Post('sales/:saleId/confirmation')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  @Throttle(SEND_THROTTLE)
  sendSaleConfirmation(
    @CurrentBusiness() businessId: string,
    @Param('saleId') saleId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.whatsapp.sendSaleConfirmation(businessId, saleId, userId);
  }

  @Post('payments/:paymentId/receipt')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  @Throttle(SEND_THROTTLE)
  sendPaymentReceipt(
    @CurrentBusiness() businessId: string,
    @Param('paymentId') paymentId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.whatsapp.sendPaymentReceipt(businessId, paymentId, userId);
  }

  @Post('customers/:customerId/outstanding-reminder')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  @Throttle(SEND_THROTTLE)
  sendOutstandingReminder(
    @CurrentBusiness() businessId: string,
    @Param('customerId') customerId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.whatsapp.sendOutstandingReminder(businessId, customerId, userId);
  }

  @Post('customers/:customerId/statement')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  @Throttle(SEND_THROTTLE)
  sendStatement(
    @CurrentBusiness() businessId: string,
    @Param('customerId') customerId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: SendStatementDto,
  ) {
    return this.whatsapp.sendStatement(businessId, customerId, userId, dto?.mutationId);
  }

  @Post('customers/:customerId/messages')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  @Throttle(SEND_THROTTLE)
  sendCustomMessage(
    @CurrentBusiness() businessId: string,
    @Param('customerId') customerId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: SendCustomMessageDto,
  ) {
    return this.whatsapp.sendCustomMessage(businessId, customerId, userId, dto.content, dto.mutationId);
  }

  // ---- Opt-in / opt-out (section 8) --------------------------------------

  @Put('customers/:customerId/opt-in')
  @RequirePermission(PERMISSIONS.WHATSAPP_SEND)
  setOptIn(
    @CurrentBusiness() businessId: string,
    @Param('customerId') customerId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: SetOptInDto,
  ) {
    return this.whatsapp.setOptIn(businessId, customerId, userId, dto.optIn);
  }

  // ---- History / search (sections 41-42) ---------------------------------

  @Get('messages')
  @RequirePermission(PERMISSIONS.WHATSAPP_VIEW)
  listMessages(
    @CurrentBusiness() businessId: string,
    @Query() pagination: PaginationDto,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('messageType') messageType?: string,
  ) {
    return this.whatsapp.listMessages(businessId, { customerId, status, messageType }, pagination);
  }

  @Get('messages/:id')
  @RequirePermission(PERMISSIONS.WHATSAPP_VIEW)
  getMessage(@CurrentBusiness() businessId: string, @Param('id') id: string) {
    return this.whatsapp.getMessage(businessId, id);
  }

  // ---- Automation settings (section 29) ----------------------------------

  @Get('settings/automation')
  @RequirePermission(PERMISSIONS.WHATSAPP_VIEW)
  getAutomationSettings(@CurrentBusiness() businessId: string) {
    return this.whatsapp.getAutomationSettings(businessId);
  }

  @Put('settings/automation')
  @RequirePermission(PERMISSIONS.WHATSAPP_MANAGE_SETTINGS)
  updateAutomationSettings(
    @CurrentBusiness() businessId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateAutomationSettingsDto,
  ) {
    return this.whatsapp.updateAutomationSettings(businessId, userId, dto);
  }
}
