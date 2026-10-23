import { Controller, Get, Post, Body, Param, Query, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PurchasesService } from './purchases.service.js';
import { CreatePurchaseDto } from './dto/create-purchase.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('purchases')
@ApiBearerAuth()
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Get()
  @ApiOperation({ summary: 'List purchases' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'supplierId', required: false })
  @RequirePermission(PERMISSIONS.PURCHASES_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('search') search?: string,
    @Query('supplierId') supplierId?: string,
  ) {
    return this.purchasesService.findAll(businessId, paginationDto, search, supplierId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single purchase' })
  @RequirePermission(PERMISSIONS.PURCHASES_VIEW)
  findOne(@CurrentBusiness() businessId: string, @Param('id') id: string) {
    return this.purchasesService.findOne(businessId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Atomic purchase engine' })
  @RequirePermission(PERMISSIONS.PURCHASES_CREATE)
  create(@CurrentBusiness() businessId: string, @Body() dto: CreatePurchaseDto) {
    return this.purchasesService.createPurchase(businessId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a mistaken purchase only when unpaid and unused' })
  @RequirePermission(PERMISSIONS.PURCHASES_DELETE)
  deletePurchase(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() body?: { reason?: string },
  ) {
    return this.purchasesService.deletePurchase(businessId, id, userId, body?.reason);
  }

  @Post('returns')
  @ApiOperation({ summary: 'Process purchase return' })
  @RequirePermission(PERMISSIONS.PURCHASES_RETURN)
  processReturn(
    @CurrentBusiness() businessId: string,
    @Body() dto: { purchaseId: string; items: Array<{ purchaseItemId: string; productId: string; quantity: number; reason: string }>; notes?: string },
  ) {
    return this.purchasesService.processPurchaseReturn(businessId, dto);
  }
}
