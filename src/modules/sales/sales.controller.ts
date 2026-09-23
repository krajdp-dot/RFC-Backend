import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SalesService } from './sales.service.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('sales')
@ApiBearerAuth()
@Controller('sales')
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  @Get()
  @ApiOperation({ summary: 'List sales' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  @RequirePermission(PERMISSIONS.SALES_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('search') search?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.salesService.findAll(businessId, paginationDto, search, customerId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single sale' })
  @RequirePermission(PERMISSIONS.SALES_VIEW)
  findOne(@CurrentBusiness() businessId: string, @Param('id') id: string) {
    return this.salesService.findOne(businessId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Atomic sale engine' })
  @RequirePermission(PERMISSIONS.SALES_CREATE)
  create(@CurrentBusiness() businessId: string, @Body() dto: CreateSaleDto) {
    return this.salesService.createSale(businessId, dto);
  }

  @Post('returns')
  @ApiOperation({ summary: 'Process customer return' })
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  processReturn(
    @CurrentBusiness() businessId: string,
    @Body() dto: { saleId: string; items: Array<{ saleItemId: string; quantity: number; reason: string; saleable?: boolean }>; notes?: string; businessDate?: string },
    @CurrentUser('userId') userId: string,
  ) {
    return this.salesService.processReturn(businessId, dto, userId);
  }

  @Post('bulk-lot')
  @ApiOperation({ summary: 'Sell one lot to multiple buyers atomically' })
  @RequirePermission(PERMISSIONS.SALES_CREATE)
  bulkLotSale(
    @CurrentBusiness() businessId: string,
    @Body() dto: {
      lotId: string;
      businessDate: string;
      allocations: Array<{
        customerId: string;
        quantity: number;
        rate: string;
        discount?: string;
        payment?: { method: string; amount: string; accountId?: string };
      }>;
    },
  ) {
    return this.salesService.bulkLotSale(businessId, dto);
  }
}
