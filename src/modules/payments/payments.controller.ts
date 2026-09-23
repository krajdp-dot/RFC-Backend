import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PaymentsService } from './payments.service.js';
import { ReceivePaymentDto } from './dto/receive-payment.dto.js';
import { MakePaymentDto } from './dto/make-payment.dto.js';
import { RefundCustomerDto } from './dto/refund-customer.dto.js';
import { RefundSupplierDto } from './dto/refund-supplier.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'List payments with filtering' })
  @ApiQuery({ name: 'type', required: false, description: 'CUSTOMER_PAYMENT, SUPPLIER_PAYMENT, or REFUND' })
  @ApiQuery({ name: 'customerId', required: false })
  @ApiQuery({ name: 'supplierId', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @RequirePermission(PERMISSIONS.PAYMENTS_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('type') type?: string,
    @Query('customerId') customerId?: string,
    @Query('supplierId') supplierId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.paymentsService.findAll(businessId, paginationDto, {
      type, customerId, supplierId, startDate, endDate,
    });
  }

  @Post('received')
  @ApiOperation({ summary: 'Record customer payment (reduces receivable)' })
  @RequirePermission(PERMISSIONS.PAYMENTS_RECEIVE)
  receivePayment(
    @CurrentBusiness() businessId: string,
    @Body() dto: ReceivePaymentDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.paymentsService.receivePayment(businessId, dto, userId);
  }

  @Post('paid')
  @ApiOperation({ summary: 'Record supplier payment (reduces payable)' })
  @RequirePermission(PERMISSIONS.PAYMENTS_MAKE)
  makePayment(
    @CurrentBusiness() businessId: string,
    @Body() dto: MakePaymentDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.paymentsService.makePayment(businessId, dto, userId);
  }

  @Post('refund-customer')
  @ApiOperation({ summary: 'Refund a customer (only valid when the linked sale has a negative creditAmount)' })
  @RequirePermission(PERMISSIONS.PAYMENTS_REFUND)
  refundCustomer(
    @CurrentBusiness() businessId: string,
    @Body() dto: RefundCustomerDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.paymentsService.refundCustomer(businessId, dto, userId);
  }

  @Post('refund-supplier')
  @ApiOperation({ summary: 'Receive a refund from a supplier (only valid when the linked purchase has a negative creditAmount)' })
  @RequirePermission(PERMISSIONS.PAYMENTS_REFUND)
  refundSupplier(
    @CurrentBusiness() businessId: string,
    @Body() dto: RefundSupplierDto,
    @CurrentUser('userId') userId: string,
  ) {
    return this.paymentsService.refundSupplier(businessId, dto, userId);
  }
}
