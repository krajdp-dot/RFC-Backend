import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DayCloseService } from './day-close.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CreateDayCloseDto } from './dto/day-close.dto.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('day-close')
@ApiBearerAuth()
@Controller('day-close')
export class DayCloseController {
  constructor(private readonly dayCloseService: DayCloseService) {}

  @Post()
  @ApiOperation({ summary: 'Snapshot today state' })
  @RequirePermission(PERMISSIONS.DAY_CLOSE_COMMIT)
  async performDayClose(
    @CurrentBusiness() businessId: string,
    @Body() data: CreateDayCloseDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.dayCloseService.performDayClose(businessId, data, userId);
  }

  @Get(':date')
  @ApiOperation({ summary: 'Get day close record by date' })
  @RequirePermission(PERMISSIONS.DAY_CLOSE_PREVIEW)
  async getDayClose(
    @CurrentBusiness() businessId: string,
    @Param('date') date: string,
  ) {
    return this.dayCloseService.getDayClose(businessId, date);
  }

  @Get(':date/preview')
  @ApiOperation({ summary: 'Preview expected cash/breakdown for a date without closing it' })
  @RequirePermission(PERMISSIONS.DAY_CLOSE_PREVIEW)
  async previewDayClose(
    @CurrentBusiness() businessId: string,
    @Param('date') date: string,
    @Query('physicalCash') physicalCash?: string,
  ) {
    return this.dayCloseService.previewDayClose(
      businessId,
      date,
      physicalCash != null ? Number(physicalCash) : null,
    );
  }
}
