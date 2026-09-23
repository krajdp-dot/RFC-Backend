import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IntelligenceService } from './intelligence.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

/**
 * Phase 13 — every route here is a read (Get) over data Sales/Purchases/
 * Inventory/Receivables/Payables/etc. already own; nothing in this
 * controller creates, updates or deletes anything (spec section 24: "no
 * destructive automation"). /brief is what the frontend's /intelligence
 * page calls; the rest exist so each domain is independently
 * addressable and independently testable.
 */
@ApiTags('intelligence')
@ApiBearerAuth()
@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly intelligenceService: IntelligenceService) {}

  @Get('brief')
  @ApiOperation({ summary: "Merchant brief \u2014 Needs Attention / Watch / Healthy / Trends, composed from every domain below" })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getBrief(@CurrentBusiness() businessId: string) { return this.intelligenceService.getBrief(businessId); }

  @Get('freshness')
  @ApiOperation({ summary: 'Freshness risk by lot' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getFreshness(@CurrentBusiness() businessId: string) { return this.intelligenceService.getFreshnessRisk(businessId); }

  @Get('stock')
  @ApiOperation({ summary: 'Stock velocity, estimated coverage, and slow/overstock signals' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getStock(@CurrentBusiness() businessId: string) { return this.intelligenceService.getStockSignals(businessId); }

  @Get('margins')
  @ApiOperation({ summary: 'Margin trend and per-product breakdown' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getMargins(@CurrentBusiness() businessId: string) { return this.intelligenceService.getMarginIntelligence(businessId); }

  @Get('collections')
  @ApiOperation({ summary: 'Customer collection risk and receivable concentration' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getCollections(@CurrentBusiness() businessId: string) { return this.intelligenceService.getCollectionIntelligence(businessId); }

  @Get('suppliers')
  @ApiOperation({ summary: 'Supplier purchase concentration and payable risk' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getSuppliers(@CurrentBusiness() businessId: string) { return this.intelligenceService.getSupplierIntelligence(businessId); }

  @Get('wastage')
  @ApiOperation({ summary: 'Wastage rate trend' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getWastage(@CurrentBusiness() businessId: string) { return this.intelligenceService.getWastageIntelligence(businessId); }

  @Get('sales-trend')
  @ApiOperation({ summary: 'Sales trend, current vs previous period' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getSalesTrend(@CurrentBusiness() businessId: string) { return this.intelligenceService.getSalesTrend(businessId); }

  @Get('expenses')
  @ApiOperation({ summary: 'Expense trend and category movement' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getExpenses(@CurrentBusiness() businessId: string) { return this.intelligenceService.getExpenseIntelligence(businessId); }

  @Get('cash')
  @ApiOperation({ summary: 'Reconciliation checks and recurring cash differences' })
  @RequirePermission(PERMISSIONS.INTELLIGENCE_VIEW)
  async getCash(@CurrentBusiness() businessId: string) { return this.intelligenceService.getCashIntelligence(businessId); }
}
