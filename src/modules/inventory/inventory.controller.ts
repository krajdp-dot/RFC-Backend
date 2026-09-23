import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { InventoryService } from './inventory.service.js';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto.js';
import { RecordWastageDto } from './dto/record-wastage.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('inventory')
@ApiBearerAuth()
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get()
  @ApiOperation({ summary: 'List products with current stock by aggregating lots' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  getAllStock(@CurrentBusiness() businessId: string) {
    return this.inventoryService.getAllStock(businessId);
  }

  @Get('at-risk')
  @ApiOperation({ summary: 'Get lots with freshnessStatus in WATCH/MARKDOWN/URGENT/LIKELY_LOSS' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  getAtRiskLots(@CurrentBusiness() businessId: string) {
    return this.inventoryService.getAtRiskLots(businessId);
  }

  @Get('products/:productId')
  @ApiOperation({ summary: 'Product stock detail with lot breakdown' })
  @ApiParam({ name: 'productId', type: 'string' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  getProductStock(
    @CurrentBusiness() businessId: string,
    @Param('productId') productId: string,
  ) {
    return this.inventoryService.getProductStock(businessId, productId);
  }

  @Post('adjustments')
  @ApiOperation({ summary: 'Stock adjustment (create InventoryMovement with ADJUSTMENT type)' })
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  recordAdjustment(
    @CurrentBusiness() businessId: string,
    @Body() dto: AdjustInventoryDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.inventoryService.recordAdjustment(businessId, dto, userId);
  }

  @Post('wastage')
  @ApiOperation({ summary: 'Record wastage (reduce lot stock, create InventoryMovement)' })
  @RequirePermission(PERMISSIONS.INVENTORY_WASTAGE)
  recordWastage(
    @CurrentBusiness() businessId: string,
    @Body() dto: RecordWastageDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.inventoryService.recordWastage(businessId, dto, userId);
  }
}
