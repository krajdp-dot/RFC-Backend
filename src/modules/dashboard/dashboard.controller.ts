import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Get single aggregated dashboard data' })
  @RequirePermission(PERMISSIONS.DASHBOARD_VIEW)
  async getDashboard(@CurrentBusiness() businessId: string) {
    return this.dashboardService.getTodayDashboard(businessId);
  }


  @Get('analytics')
  @ApiOperation({ summary: 'Get accurate period summaries, trend points, and recent transactions for the dashboard' })
  @RequirePermission(PERMISSIONS.DASHBOARD_VIEW)
  async getAnalytics(
    @CurrentBusiness() businessId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupBy') groupBy?: string,
    @CurrentUser('role') role?: string,
  ) {
    return this.dashboardService.getAnalytics(businessId, startDate, endDate, groupBy, role || 'UNKNOWN');
  }

  @Get('reorder')
  @ApiOperation({ summary: 'Products at or below their configured reorder threshold, with recommended reorder quantity' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  async getReorderRecommendations(@CurrentBusiness() businessId: string) {
    return this.dashboardService.getReorderRecommendations(businessId);
  }
}
