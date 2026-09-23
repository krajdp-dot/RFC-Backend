import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BusinessesService } from './businesses.service.js';
import { UpdateBusinessDto } from './dto/update-business.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('businesses')
@ApiBearerAuth()
@Controller('businesses')
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  @Get('current')
  @ApiOperation({ summary: 'Get current business details' })
  @RequirePermission(PERMISSIONS.BUSINESS_VIEW)
  async getCurrent(@CurrentBusiness() businessId: string) {
    return this.businessesService.getCurrentBusiness(businessId);
  }

  @Put('current')
  @ApiOperation({ summary: 'Update current business profile' })
  @RequirePermission(PERMISSIONS.BUSINESS_EDIT)
  async updateCurrent(
    @CurrentBusiness() businessId: string,
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businessesService.updateCurrentBusiness(businessId, dto);
  }
}
