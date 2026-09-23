import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReconciliationService } from './reconciliation.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CashReconciliationDto, InventoryReconciliationDto } from './dto/reconciliation.dto.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconService: ReconciliationService) {}

  @Post('cash')
  @ApiOperation({ summary: 'Cash reconciliation' })
  @RequirePermission(PERMISSIONS.RECONCILIATION_RUN)
  async reconcileCash(
    @CurrentBusiness() businessId: string,
    @Body() data: CashReconciliationDto,
  ) {
    return this.reconService.reconcileCash(businessId, data);
  }

  @Post('inventory')
  @ApiOperation({ summary: 'Inventory reconciliation' })
  @RequirePermission(PERMISSIONS.RECONCILIATION_RUN)
  async reconcileInventory(
    @CurrentBusiness() businessId: string,
    @Body() data: InventoryReconciliationDto,
  ) {
    return this.reconService.reconcileInventory(businessId, data);
  }

  @Get('verification')
  @ApiOperation({ summary: 'Data integrity check' })
  @RequirePermission(PERMISSIONS.RECONCILIATION_VIEW)
  async getVerification(@CurrentBusiness() businessId: string) {
    return this.reconService.getVerification(businessId);
  }
}
