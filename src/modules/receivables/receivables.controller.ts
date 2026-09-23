import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReceivablesService } from './receivables.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('receivables')
@ApiBearerAuth()
@Controller('receivables')
export class ReceivablesController {
  constructor(private readonly receivablesService: ReceivablesService) {}

  @Get()
  @ApiOperation({ summary: 'Get customer receivables summary' })
  @RequirePermission(PERMISSIONS.RECEIVABLES_VIEW)
  async getSummary(@CurrentBusiness() businessId: string) {
    return this.receivablesService.getReceivablesSummary(businessId);
  }

  @Get('aging')
  @ApiOperation({ summary: 'Get aging analysis across all customers' })
  @RequirePermission(PERMISSIONS.RECEIVABLES_VIEW)
  async getAgingAnalysis(@CurrentBusiness() businessId: string) {
    return this.receivablesService.getAgingAnalysis(businessId);
  }
}
