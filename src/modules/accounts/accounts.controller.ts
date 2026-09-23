import { Controller, Get, Post, Body, Put, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AccountsService } from './accounts.service.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { UpdateAccountDto } from './dto/update-account.dto.js';
import { CreateTransferDto } from './dto/create-transfer.dto.js';
import { AdjustOpeningBalanceDto } from './dto/adjust-opening-balance.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new account' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_MANAGE)
  create(
    @CurrentBusiness() businessId: string,
    @Body() createAccountDto: CreateAccountDto,
  ) {
    return this.accountsService.create(businessId, createAccountDto);
  }

  @Get()
  @ApiOperation({ summary: 'List all accounts with balances' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.accountsService.findAll(businessId, paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single account with balance' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_VIEW)
  findOne(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
  ) {
    return this.accountsService.findOne(businessId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update account (opening balance cannot be changed here — see /opening-balance)' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_MANAGE)
  update(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.accountsService.update(businessId, id, updateAccountDto);
  }

  @Post(':id/opening-balance')
  @ApiOperation({ summary: 'Adjust an account\u2019s opening balance (requires a reason; audited atomically)' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_OPENING_BALANCE)
  adjustOpeningBalance(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() dto: AdjustOpeningBalanceDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.accountsService.adjustOpeningBalance(businessId, id, dto, userId);
  }

  @Get(':id/transactions')
  @ApiOperation({ summary: 'Get account ledger transactions' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_VIEW)
  getTransactions(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.accountsService.getAccountTransactions(businessId, id, paginationDto);
  }

  @Post('transfers')
  @ApiOperation({ summary: 'Transfer money between accounts' })
  @RequirePermission(PERMISSIONS.ACCOUNTS_TRANSFER)
  createTransfer(
    @CurrentBusiness() businessId: string,
    @Body() createTransferDto: CreateTransferDto,
  ) {
    return this.accountsService.createTransfer(businessId, createTransferDto);
  }
}
