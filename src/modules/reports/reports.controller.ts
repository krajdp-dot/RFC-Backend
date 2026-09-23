import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { DateRangeDto } from './dto/date-range.dto.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('sales')
  @ApiOperation({ summary: 'Sales report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getSales(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getSales(businessId, q); }

  @Get('purchases')
  @ApiOperation({ summary: 'Purchases report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getPurchases(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getPurchases(businessId, q); }

  @Get('cash-flow')
  @ApiOperation({ summary: 'Cash flow report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getCashFlow(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getCashFlow(businessId, q); }

  @Get('money-flow')
  @ApiOperation({ summary: 'Money flow waterfall' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getMoneyFlow(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getMoneyFlow(businessId, q); }

  @Get('pnl')
  @ApiOperation({ summary: 'Profit & Loss report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getPnl(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getPnl(businessId, q); }

  @Get('inventory')
  @ApiOperation({ summary: 'Inventory valuation report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getInventory(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getInventory(businessId, q); }

  @Get('freshness')
  @ApiOperation({ summary: 'Freshness/quality report' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getFreshness(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getFreshness(businessId, q); }

  @Get('wastage')
  @ApiOperation({ summary: 'Wastage analysis' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getWastage(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getWastage(businessId, q); }

  @Get('margins')
  @ApiOperation({ summary: 'Product margin analysis' })
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async getMargins(@CurrentBusiness() businessId: string, @Query() q: DateRangeDto) { return this.reportsService.getMargins(businessId, q); }
}
