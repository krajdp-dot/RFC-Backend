import { LotStatus, TransactionStatus, PaymentTransactionType, InventoryMovementType, UnitType, AuditAction } from '../../common/enums.js';
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service.js';
import { LotsService } from '../lots/lots.service.js';
import { CreateSaleDto } from './dto/create-sale.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { toDecimal, sumDecimal, mulDecimal, toMoneyString } from '../../common/utils/money.util.js';
import { generateReference } from '../../common/utils/reference.util.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';
import { AuditService } from '../audit/audit.service.js';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class SalesService {
  constructor(
    private prisma: PrismaService,
    private lotsService: LotsService,
    private auditService: AuditService,
    private eventEmitter: EventEmitter2,
  ) {}

  // B3 fix: include customer + items; B12 fix: search support
  async findAll(businessId: string, paginationDto?: PaginationDto, search?: string, customerId?: string) {
    const skip = paginationDto?.skip || 0;
    const take = paginationDto?.take || 20;

    const where: any = { businessId };
    // Phase 8: the receive-payment screen needs "this customer's credit
    // sales" specifically — there was no server-side way to ask for that,
    // so it was fetching sales across every customer and relying on a
    // client-side creditAmount>0 filter, which surfaced other customers'
    // outstanding sales in the "pay against this sale" dropdown too.
    if (customerId) {
      where.customerId = customerId;
    }
    if (search && search.trim()) {
      where.OR = [
        { saleReference: { contains: search.trim(), mode: 'insensitive' } },
        { customer: { name: { contains: search.trim(), mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          customer: { select: { name: true, id: true } },
          items: { include: { product: { select: { name: true } } } },
        },
      }),
      this.prisma.sale.count({ where }),
    ]);

    return paginatedResponse(items, total, paginationDto?.page || 1, paginationDto?.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    return this.prisma.sale.findFirst({
      where: { id, businessId },
      include: {
        items: { include: { product: { select: { name: true } }, lot: { select: { lotReference: true } } } },
        payments: true,
        customer: { select: { name: true, id: true } },
      }
    });
  }

  async createSale(businessId: string, dto: CreateSaleDto) {
    const sale = await this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.sale.findFirst({
          where: { businessId, idempotencyKey: dto.idempotencyKey }
        });
        if (existing) return existing;
      }

      const customer = await tx.customer.findFirst({ where: { id: dto.customerId, businessId } });
      if (!customer || !customer.active) throw new BadRequestException('Invalid customer');

      const saleReference = generateReference('SALE', dto.businessDate);
      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      let totalCogs = toDecimal(0);
      let subtotal = toDecimal(0);
      
      const createdItems: any[] = [];

      for (const item of dto.items) {
        const itemTotal = mulDecimal(item.quantity, item.rate);
        subtotal = sumDecimal(subtotal, itemTotal);

        const availableLots = await this.lotsService.getFEFOLots(tx, businessId, item.productId);
        
        let remainingNeeded = toDecimal(item.quantity);
        let itemCogs = toDecimal(0);
        let itemWeightKg = toDecimal(0);
        let allocatedLotId: string | null = null;

        for (const lot of availableLots) {
          if (remainingNeeded.lte(0)) break;

          let takeBoxes = 0;
          let takeKg = toDecimal(0);
          let costForTaken = toDecimal(0);

          if (item.unit === UnitType.BOX) {
            takeBoxes = Math.min(remainingNeeded.toNumber(), lot.remainingBoxes);
            remainingNeeded = remainingNeeded.minus(takeBoxes);
            
            if (lot.totalBoxes > 0) {
              const avgWeight = toDecimal(lot.totalNetWeightKg).dividedBy(lot.totalBoxes);
              takeKg = avgWeight.times(takeBoxes);
            }
            costForTaken = mulDecimal(takeBoxes, lot.costPerBox);
          } else if (item.unit === UnitType.KG) {
            const availableKg = toDecimal(lot.remainingNetWeightKg);
            // If lot has 0 remainingNetWeightKg but still active, fallback to avg weight
            let actualAvailableKg = availableKg;
            if (availableKg.lte(0) && lot.remainingBoxes > 0 && lot.totalBoxes > 0) {
              actualAvailableKg = toDecimal(lot.totalNetWeightKg).dividedBy(lot.totalBoxes).times(lot.remainingBoxes);
            }
            
            takeKg = remainingNeeded.lt(actualAvailableKg) ? remainingNeeded : actualAvailableKg;
            remainingNeeded = remainingNeeded.minus(takeKg);
            
            if (toDecimal(lot.totalNetWeightKg).gt(0)) {
               const avgKgPerBox = toDecimal(lot.totalNetWeightKg).dividedBy(lot.totalBoxes);
               takeBoxes = Math.floor(takeKg.dividedBy(avgKgPerBox).toNumber());
               takeBoxes = Math.min(takeBoxes, lot.remainingBoxes);
            }
            costForTaken = mulDecimal(takeKg, lot.costPerKg);
          }

          if (takeBoxes === 0 && takeKg.lte(0)) continue;

          itemCogs = sumDecimal(itemCogs, costForTaken);
          itemWeightKg = sumDecimal(itemWeightKg, takeKg);
          allocatedLotId = lot.id;

          await tx.lot.update({
            where: { id: lot.id },
            data: {
              remainingBoxes: { decrement: takeBoxes },
              remainingNetWeightKg: { decrement: takeKg.toNumber() }
            }
          });

          const updatedLot = await tx.lot.findUnique({ where: { id: lot.id } });
          if (updatedLot && (updatedLot.remainingBoxes < 0 || toDecimal(updatedLot.remainingNetWeightKg).lt(0))) {
            // Phase 11: carries a stable `code` (picked up by
            // GlobalExceptionFilter's `resp.code` check) instead of just a
            // message, so a client replaying this mutation after being
            // offline — where "try again" isn't a thing a queued retry can
            // just do blindly — can tell this apart from a permanent
            // validation failure and route it to human review instead of
            // silently retrying or silently dropping it. See Phase 11
            // architecture doc, "Conflict classification".
            throw new BadRequestException({
              message: `Concurrent sale resulted in negative stock for product ${item.productId}. Please try again.`,
              code: 'STALE_VERSION',
            });
          }
          if (updatedLot && updatedLot.remainingBoxes === 0 && toDecimal(updatedLot.remainingNetWeightKg).lte(0.1)) {
            await tx.lot.update({
              where: { id: lot.id },
              data: { status: LotStatus.DEPLETED }
            });
          }

          await tx.inventoryMovement.create({
            data: {
              businessId,
              lotId: lot.id,
              productId: lot.productId,
              movementType: InventoryMovementType.SALE,
              quantityBoxes: -takeBoxes,
              quantityWeightKg: takeKg.negated(),
              transactionType: 'SALE',
              transactionId: saleReference,
              businessDate: bDate,
              costPerUnit: item.unit === UnitType.BOX ? lot.costPerBox : lot.costPerKg,
              totalCost: costForTaken,
              notes: `Sold in ${saleReference}`
            }
          });
        }

        if (remainingNeeded.gt(0.01)) {
          // Phase 11: the named scenario for offline conflicts (section 17)
          // — stock cached on a device when it went offline no longer
          // covers a queued sale by the time it syncs. `code` lets the
          // sync engine mark this CONFLICT (needs a human decision) rather
          // than retrying it forever or, worse, silently shrinking the
          // sale to whatever stock happens to be left.
          throw new BadRequestException({
            message: `Insufficient stock for product ${item.productId}`,
            code: 'INSUFFICIENT_STOCK',
          });
        }

        totalCogs = sumDecimal(totalCogs, itemCogs);

        createdItems.push({
          productId: item.productId,
          lotId: allocatedLotId,
          quantity: item.quantity,
          unit: item.unit,
          rate: toDecimal(item.rate),
          total: itemTotal,
          costPerUnit: itemCogs.dividedBy(item.quantity || 1),
          cogs: itemCogs,
          grossProfit: itemTotal.minus(itemCogs),
          // Phase 7: populated for the first time — the FEFO allocation
          // loop above already computes the exact kg drawn from each lot
          // (used for InventoryMovement.quantityWeightKg either way), it
          // just wasn't being carried onto the SaleItem row itself, so any
          // reader of SaleItem (e.g. a future receipt/detail view) had no
          // weight for BOX-unit sales. Harmless for KG-unit items too:
          // itemWeightKg there equals item.quantity, kept as its own field
          // rather than assumed equal so a reader never has to know which
          // unit a row used to find its weight.
          weightKg: itemWeightKg,
        });
      }

      const total = subtotal.minus(toDecimal(dto.discount || 0));
      const grossProfit = total.minus(totalCogs);

      let received = toDecimal(0);
      for (const p of dto.payments) {
        received = sumDecimal(received, p.amount);
      }

      const creditAmount = total.minus(received);

      const sale = await tx.sale.create({
        data: {
          businessId,
          saleReference,
          customerId: dto.customerId,
          businessDate: bDate,
          subtotal,
          discount: toDecimal(dto.discount || 0),
          total,
          received,
          creditAmount,
          cogs: totalCogs,
          grossProfit,
          status: TransactionStatus.COMPLETED,
          idempotencyKey: dto.idempotencyKey,
          notes: dto.notes,
          items: { create: createdItems }
        }
      });

      // Process payments
      for (const p of dto.payments) {
        const payment = await tx.payment.create({
          data: {
            businessId,
            idempotencyKey: generateReference('PAYMENT_IN', dto.businessDate),
            transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
            amount: toDecimal(p.amount),
            method: p.method,
            businessDate: bDate,
            customerId: dto.customerId,
            accountId: p.accountId,
            saleId: sale.id
          }
        });

        if (p.accountId) {
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: p.accountId,
              transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
              transactionId: payment.id,
              entityType: 'CUSTOMER',
              entityId: dto.customerId,
              debit: toDecimal(p.amount),
              businessDate: bDate,
              description: `Payment received for sale ${saleReference}`
            }
          });
        }
      }

      // --- DOUBLE-ENTRY ACCOUNTING FOR SALE ---
      
      // 1. Get/Create System Accounts
      const getAccount = async (type, name) => {
        let acc = await tx.account.findFirst({ where: { businessId, type } });
        if (!acc) acc = await tx.account.create({ data: { businessId, name, type } });
        return acc;
      };

      const receivableAccount = await getAccount('CUSTOMER_RECEIVABLE', 'Customer Receivables');
      const revenueAccount = await getAccount('SALES_REVENUE', 'Sales Revenue');
      const cogsAccount = await getAccount('COGS', 'Cost of Goods Sold');
      const inventoryAccount = await getAccount('INVENTORY_ASSET', 'Inventory Asset');

      // 2. Recognize Sales Revenue (Credit)
      await tx.ledgerEntry.create({
        data: {
          businessId, accountId: revenueAccount.id, transactionType: 'SALE', transactionId: sale.id,
          entityType: 'CUSTOMER', entityId: dto.customerId, credit: total, businessDate: bDate,
          description: `Sales Revenue for ${saleReference}`
        }
      });

      // 3. Recognize Accounts Receivable (Debit for the credit portion)
      if (creditAmount.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            businessId, accountId: receivableAccount.id, transactionType: 'SALE', transactionId: sale.id,
            entityType: 'CUSTOMER', entityId: dto.customerId, debit: creditAmount, businessDate: bDate,
            description: `Credit sale ${saleReference} - receivable from ${customer.name}`
          }
        });
      }

      // 4. Recognize COGS (Debit) and Inventory (Credit)
      if (totalCogs.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            businessId, accountId: cogsAccount.id, transactionType: 'SALE', transactionId: sale.id,
            debit: totalCogs, businessDate: bDate, description: `COGS for ${saleReference}`
          }
        });
        await tx.ledgerEntry.create({
          data: {
            businessId, accountId: inventoryAccount.id, transactionType: 'SALE', transactionId: sale.id,
            credit: totalCogs, businessDate: bDate, description: `Inventory deduction for ${saleReference}`
          }
        });
      }

      return sale;
    });

    // Phase 12, section 27: a listener (not this service) decides
    // whether this becomes a WhatsApp message — SalesService knows
    // nothing about WhatsApp, automation settings, or opt-in. Fired
    // after the transaction above has committed, so this can only ever
    // represent a sale that genuinely exists; an idempotent replay
    // (dto.idempotencyKey matching an existing sale) fires this again on
    // the same sale.id, which is harmless — the listener's own send is
    // independently idempotent (WhatsAppMessage.idempotencyKey), so a
    // duplicate event produces zero duplicate messages, not "eventually
    // consistent, probably fine."
    this.eventEmitter.emit('sale.created', { businessId, saleId: sale.id });

    return sale;
  }

  // B7: Customer Return
  async processReturn(businessId: string, dto: {
    saleId: string;
    items: Array<{ saleItemId: string; quantity: number; reason: string; saleable?: boolean }>;
    notes?: string;
    businessDate?: string;
  }, actingUserId?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      // Same contested resource as a payment against this sale — lock it
      // for the same reason receivePayment does.
      await tx.$queryRaw`SELECT id FROM sales WHERE id = ${dto.saleId} AND "businessId" = ${businessId} FOR UPDATE`;

      // Phase 9: this had no closed-business-date check at all — every
      // other mutation against a sale (a new sale, a payment, a refund)
      // rejects on a closed date; a return could silently slip through.
      // Same guard, same position (after the row lock) as receivePayment.
      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      // Flat queries + in-memory join instead of `include: { items: true,
      // customer: true }` — resolves fine against real Postgres, but is a
      // silent no-op against this repo's FakePrismaService test double,
      // which is exactly why this method had no direct test coverage
      // before Phase 9 (only a simulated-effect test in
      // payments.service.spec.ts that set creditAmount directly rather
      // than calling this method).
      const sale = await tx.sale.findFirst({ where: { id: dto.saleId, businessId } });
      if (!sale) throw new NotFoundException('Sale not found');
      const items = await tx.saleItem.findMany({ where: { saleId: sale.id } });

      let totalReturnAmount = toDecimal(0);

      for (const returnItem of dto.items) {
        const origItem = items.find((i: any) => i.id === returnItem.saleItemId);
        if (!origItem) throw new BadRequestException(`Sale item ${returnItem.saleItemId} not found`);
        if (returnItem.quantity <= 0) throw new BadRequestException('Return quantity must be positive');
        if (returnItem.quantity > Number(origItem.quantity)) {
          throw new BadRequestException('Return quantity exceeds sold quantity');
        }

        const returnValue = toDecimal(origItem.rate).times(returnItem.quantity);
        totalReturnAmount = sumDecimal(totalReturnAmount, returnValue);

        // If saleable, restore to inventory
        if (returnItem.saleable !== false && origItem.lotId) {
          const lot = await tx.lot.findFirst({ where: { id: origItem.lotId, businessId } });
          if (lot) {
            await tx.lot.update({
              where: { id: lot.id },
              data: {
                remainingBoxes: lot.remainingBoxes + returnItem.quantity,
                status: LotStatus.ACTIVE,
              }
            });

            await tx.inventoryMovement.create({
              data: {
                businessId,
                lotId: lot.id,
                productId: origItem.productId,
                movementType: InventoryMovementType.RETURN_FROM_CUSTOMER,
                quantityBoxes: returnItem.quantity,
                transactionType: 'CUSTOMER_RETURN',
                transactionId: sale.id,
                businessDate: bDate,
                costPerUnit: origItem.costPerUnit,
                totalCost: toDecimal(origItem.costPerUnit).times(returnItem.quantity),
                notes: `Return: ${returnItem.reason}`,
              }
            });
          }
        }
      }

      // Adjust customer receivable. Not clamped at zero: if the sale was
      // already fully paid, this goes negative — that negative value IS the
      // record of money now owed back to the customer (see PaymentsService
      // .refundCustomer, the only way to pay it out). Clamping here would
      // silently discard that the business now owes them money.
      let newCreditAmount = sale.creditAmount;
      if (totalReturnAmount.gt(0)) {
        newCreditAmount = toDecimal(sale.creditAmount).minus(totalReturnAmount);
        await tx.sale.update({
          where: { id: sale.id },
          data: { creditAmount: newCreditAmount }
        });

        // Phase 9: find-or-CREATE, not just find — this method previously
        // only looked up an existing CUSTOMER_RECEIVABLE account and
        // silently posted nothing if none existed yet. That's exactly the
        // Section 9 scenario (sale fully paid up front, so no receivable
        // account was ever auto-vivified by createSale in the first
        // place) — a return on a fully-paid sale was posting no ledger
        // entry at all.
        let receivableAccount = await tx.account.findFirst({ where: { businessId, type: 'CUSTOMER_RECEIVABLE' } });
        if (!receivableAccount) {
          receivableAccount = await tx.account.create({
            data: { businessId, name: 'Customer Receivables', type: 'CUSTOMER_RECEIVABLE' },
          });
        }
        await tx.ledgerEntry.create({
          data: {
            businessId,
            accountId: receivableAccount.id,
            transactionType: 'CUSTOMER_RETURN',
            transactionId: sale.id,
            entityType: 'CUSTOMER',
            entityId: sale.customerId,
            credit: totalReturnAmount,
            businessDate: bDate,
            description: `Customer return for ${sale.saleReference}`
          }
        });

        // Phase 9: the credit above (receivable decreasing) had no
        // matching debit anywhere — reverses the SALES_REVENUE side of the
        // original sale (find-or-create: same reasoning as
        // receivableAccount just above).
        let revenueAccount = await tx.account.findFirst({ where: { businessId, type: 'SALES_REVENUE' } });
        if (!revenueAccount) {
          revenueAccount = await tx.account.create({
            data: { businessId, name: 'Sales Revenue', type: 'SALES_REVENUE' },
          });
        }
        await tx.ledgerEntry.create({
          data: {
            businessId,
            accountId: revenueAccount.id,
            transactionType: 'CUSTOMER_RETURN',
            transactionId: sale.id,
            entityType: 'CUSTOMER',
            entityId: sale.customerId,
            debit: totalReturnAmount,
            businessDate: bDate,
            description: `Revenue reversal for return against ${sale.saleReference}`
          }
        });

        await this.auditService.record(tx, {
          businessId,
          userId: actingUserId,
          action: AuditAction.UPDATE,
          entityType: 'SALE',
          entityId: sale.id,
          before: { creditAmount: toMoneyString(sale.creditAmount) },
          after: { creditAmount: toMoneyString(newCreditAmount) },
          reason: dto.notes || 'Customer return',
        });

        if (newCreditAmount.lt(0)) {
          return {
            success: true,
            returnAmount: toMoneyString(totalReturnAmount),
            refundOwed: toMoneyString(newCreditAmount.abs()),
            message: 'Sale was already fully paid \u2014 a refund is now owed to the customer.',
            sale: { ...sale, creditAmount: toMoneyString(newCreditAmount) },
          };
        }
      }

      return {
        success: true,
        returnAmount: toMoneyString(totalReturnAmount),
        sale: { ...sale, creditAmount: toMoneyString(newCreditAmount) },
      };
    });
  }

  // B6: Bulk Lot Sale
  async bulkLotSale(businessId: string, dto: {
    lotId: string;
    businessDate: string;
    allocations: Array<{
      customerId: string;
      quantity: number;
      rate: string;
      discount?: string;
      payment?: { method: string; amount: string; accountId?: string };
    }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.lot.findFirst({
        where: { id: dto.lotId, businessId, status: LotStatus.ACTIVE },
        include: { product: true },
      });
      if (!lot) throw new NotFoundException('Lot not found or depleted');

      const totalRequested = dto.allocations.reduce((sum, a) => sum + a.quantity, 0);
      if (totalRequested > lot.remainingBoxes) {
        throw new BadRequestException(
          `Requested ${totalRequested} boxes but only ${lot.remainingBoxes} available`
        );
      }

      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);
      const results: any[] = [];

      for (const alloc of dto.allocations) {
        const customer = await tx.customer.findFirst({ where: { id: alloc.customerId, businessId } });
        if (!customer || !customer.active) {
          throw new BadRequestException(`Invalid customer ${alloc.customerId}`);
        }

        const saleReference = generateReference('SALE', dto.businessDate);
        const itemTotal = mulDecimal(alloc.quantity, alloc.rate);
        const discount = toDecimal(alloc.discount || 0);
        const total = itemTotal.minus(discount);
        const itemCogs = mulDecimal(alloc.quantity, lot.costPerBox);
        const grossProfit = total.minus(itemCogs);

        let received = toDecimal(0);
        let creditAmount = total;

        const sale = await tx.sale.create({
          data: {
            businessId,
            saleReference,
            customerId: alloc.customerId,
            businessDate: bDate,
            subtotal: itemTotal,
            discount,
            total,
            received: toDecimal(0),
            creditAmount: total,
            cogs: itemCogs,
            grossProfit,
            status: TransactionStatus.COMPLETED,
            notes: `Bulk lot sale from ${lot.lotReference}`,
            items: {
              create: [{
                productId: lot.productId,
                lotId: lot.id,
                quantity: alloc.quantity,
                unit: lot.product.primaryUnit || 'BOX',
                rate: toDecimal(alloc.rate),
                total: itemTotal,
                costPerUnit: lot.costPerBox,
                cogs: itemCogs,
                grossProfit: itemTotal.minus(itemCogs),
              }]
            }
          }
        });

        // Inventory movement
        await tx.inventoryMovement.create({
          data: {
            businessId,
            lotId: lot.id,
            productId: lot.productId,
            movementType: InventoryMovementType.SALE,
            quantityBoxes: -alloc.quantity,
            transactionType: 'SALE',
            transactionId: sale.id,
            businessDate: bDate,
            costPerUnit: lot.costPerBox,
            totalCost: itemCogs,
            notes: `Bulk sale ${saleReference} to ${customer.name}`,
          }
        });

        // Handle payment if provided
        if (alloc.payment && toDecimal(alloc.payment.amount).gt(0)) {
          received = toDecimal(alloc.payment.amount);
          creditAmount = total.minus(received);

          const payment = await tx.payment.create({
            data: {
              businessId,
              idempotencyKey: generateReference('PAYMENT_IN', dto.businessDate),
              transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
              amount: received,
              method: alloc.payment.method,
              businessDate: bDate,
              customerId: alloc.customerId,
              accountId: alloc.payment.accountId,
              saleId: sale.id,
            }
          });

          if (alloc.payment.accountId) {
            await tx.ledgerEntry.create({
              data: {
                businessId,
                accountId: alloc.payment.accountId,
                transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
                transactionId: payment.id,
                entityType: 'CUSTOMER',
                entityId: alloc.customerId,
                debit: received,
                businessDate: bDate,
                description: `Payment for bulk sale ${saleReference}`
              }
            });
          }

          await tx.sale.update({
            where: { id: sale.id },
            data: { received, creditAmount }
          });
        }

        // Ledger for credit
        if (creditAmount.gt(0)) {
          let receivableAccount = await tx.account.findFirst({ where: { businessId, type: 'CUSTOMER_RECEIVABLE' } });
          if (!receivableAccount) {
            receivableAccount = await tx.account.create({
              data: { businessId, name: 'Customer Receivables', type: 'CUSTOMER_RECEIVABLE' }
            });
          }
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: receivableAccount.id,
              transactionType: 'SALE',
              transactionId: sale.id,
              entityType: 'CUSTOMER',
              entityId: alloc.customerId,
              debit: creditAmount,
              businessDate: bDate,
              description: `Credit bulk sale ${saleReference} to ${customer.name}`
            }
          });
        }

        results.push({ saleId: sale.id, saleReference, customerId: alloc.customerId, total: toMoneyString(total) });
      }

      // Update lot quantity
      await tx.lot.update({
        where: { id: lot.id },
        data: {
          remainingBoxes: { decrement: totalRequested },
        }
      });

      const updatedLot = await tx.lot.findUnique({ where: { id: lot.id } });
      if (updatedLot && updatedLot.remainingBoxes < 0) {
        throw new BadRequestException(`Concurrent sale resulted in negative stock for lot ${lot.lotReference}. Please try again.`);
      }
      if (updatedLot && updatedLot.remainingBoxes === 0) {
        await tx.lot.update({
          where: { id: lot.id },
          data: { status: LotStatus.DEPLETED }
        });
      }

      return { success: true, sales: results, lotRemaining: updatedLot?.remainingBoxes };
    });
  }
}
