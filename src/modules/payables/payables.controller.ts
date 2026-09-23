import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PayablesService } from './payables.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('payables')
@ApiBearerAuth()
@Controller('payables')
export class PayablesController {
  constructor(private readonly payablesService: PayablesService) {}

  @Get()
  @ApiOperation({ summary: 'Get supplier payables summary' })
  @RequirePermission(PERMISSIONS.PAYABLES_VIEW)
  async getSummary(@CurrentBusiness() businessId: string) {
    return this.payablesService.getPayablesSummary(businessId);
  }

  @Get('aging')
  @ApiOperation({ summary: 'Get aging analysis across all suppliers' })
  @RequirePermission(PERMISSIONS.PAYABLES_VIEW)
  async getAgingAnalysis(@CurrentBusiness() businessId: string) {
    return this.payablesService.getAgingAnalysis(businessId);
  }
}
