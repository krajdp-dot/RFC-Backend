import { LotStatus, TransactionStatus, PaymentTransactionType, MovementType , InventoryMovementType, AuditAction } from '../../common/enums.js';
import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service.js';
import { CreatePurchaseDto } from './dto/create-purchase.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { toDecimal, sumDecimal, mulDecimal, divDecimal, toMoneyString } from '../../common/utils/money.util.js';
import { generateReference, generateLotReference } from '../../common/utils/reference.util.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class PurchasesService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
  ) {}

  async findAll(businessId: string, paginationDto?: PaginationDto, search?: string, supplierId?: string) {
    const skip = paginationDto?.skip || 0;
    const take = paginationDto?.take || 20;

    const where: any = { businessId };
    // Phase 8: mirrors the same fix in sales.service.ts's findAll — the
    // make-payment screen needs "this supplier's credit purchases"
    // specifically, and had no server-side way to ask for that.
    if (supplierId) {
      where.supplierId = supplierId;
    }
    if (search && search.trim()) {
      where.OR = [
        { purchaseReference: { contains: search.trim(), mode: 'insensitive' } },
        { supplier: { name: { contains: search.trim(), mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          supplier: { select: { name: true, id: true } },
          items: { include: { product: { select: { name: true } } } },
        },
      }),
      this.prisma.purchase.count({ where }),
    ]);

    return paginatedResponse(items, total, paginationDto?.page || 1, paginationDto?.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    return this.prisma.purchase.findFirst({
      where: { id, businessId },
      include: {
        items: { include: { product: { select: { name: true } } } },
        payments: true,
        lots: true,
        supplier: { select: { name: true, id: true } },
      }
    });
  }

  async createPurchase(businessId: string, dto: CreatePurchaseDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.purchase.findFirst({
          where: { businessId, idempotencyKey: dto.idempotencyKey }
        });
        if (existing) return existing;
      }

      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, businessId } });
      if (!supplier || !supplier.active) throw new BadRequestException('Invalid supplier');

      const purchaseRef = generateReference('PURCHASE', dto.businessDate);
      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      let subtotal = toDecimal(0);
      for (const item of dto.items) {
        subtotal = sumDecimal(subtotal, mulDecimal(item.quantityBoxes, item.ratePerUnit));
      }

      const transport = toDecimal(dto.transport || 0);
      const loading = toDecimal(dto.loading || 0);
      const unloading = toDecimal(dto.unloading || 0);
      const otherCosts = toDecimal(dto.otherCosts || 0);

      const totalCosts = sumDecimal(transport, loading, unloading, otherCosts);
      const landedCostTotal = sumDecimal(subtotal, totalCosts);

      let paid = toDecimal(0);
      for (const p of dto.payments) paid = sumDecimal(paid, p.amount);

      const creditAmount = landedCostTotal.minus(paid);

      const purchase = await tx.purchase.create({
        data: {
          businessId,
          purchaseReference: purchaseRef,
          supplierId: dto.supplierId,
          businessDate: bDate,
          subtotal,
          transport,
          loading,
          unloading,
          otherCosts,
          landedCost: landedCostTotal,
          paid,
          creditAmount: creditAmount,
          status: TransactionStatus.COMPLETED,
          idempotencyKey: dto.idempotencyKey,
          notes: dto.notes
        }
      });

      // Process payments and post ledger entries for each
      for (const p of dto.payments) {
        const payment = await tx.payment.create({
          data: {
            businessId,
            idempotencyKey: generateReference('PAYMENT_OUT', dto.businessDate),
            transactionType: PaymentTransactionType.SUPPLIER_PAYMENT,
            amount: toDecimal(p.amount),
            method: p.method,
            businessDate: bDate,
            supplierId: dto.supplierId,
            accountId: p.accountId,
            purchaseId: purchase.id
          }
        });

        if (p.accountId) {
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: p.accountId,
              transactionType: PaymentTransactionType.SUPPLIER_PAYMENT,
              transactionId: payment.id,
              entityType: 'SUPPLIER',
              entityId: dto.supplierId,
              credit: toDecimal(p.amount),
              businessDate: bDate,
              description: `Payment for purchase ${purchaseRef}`
            }
          });
        }
      }

      // --- DOUBLE-ENTRY ACCOUNTING FOR PURCHASE ---
      const getAccount = async (type, name) => {
        let acc = await tx.account.findFirst({ where: { businessId, type } });
        if (!acc) acc = await tx.account.create({ data: { businessId, name, type } });
        return acc;
      };

      const inventoryAccount = await getAccount('INVENTORY_ASSET', 'Inventory Asset');
      const payableAccount = await getAccount('SUPPLIER_PAYABLE', 'Supplier Payables');

      // 1. Recognize Inventory Asset (Debit)
      if (landedCostTotal.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            businessId, accountId: inventoryAccount.id, transactionType: 'PURCHASE', transactionId: purchase.id,
            entityType: 'SUPPLIER', entityId: dto.supplierId, debit: landedCostTotal, businessDate: bDate,
            description: `Inventory capitalized for purchase ${purchaseRef}`
          }
        });
      }

      // 2. Recognize Supplier Payable (Credit) for the unpaid amount
      if (creditAmount.gt(0)) {
        await tx.ledgerEntry.create({
          data: {
            businessId, accountId: payableAccount.id, transactionType: 'PURCHASE', transactionId: purchase.id,
            entityType: 'SUPPLIER', entityId: dto.supplierId, credit: creditAmount, businessDate: bDate,
            description: `Credit purchase ${purchaseRef} - payable to ${supplier.name}`
          }
        });
      }

      // Create items, lots, and inventory movements
      for (const item of dto.items) {
        const product = await tx.product.findFirst({ where: { id: item.productId, businessId } });
        if (!product) throw new BadRequestException('Invalid product');

        const itemTotal = mulDecimal(item.quantityBoxes, item.ratePerUnit);
        
        let itemLandedCost = itemTotal;
        if (subtotal.greaterThan(0)) {
          const ratio = divDecimal(itemTotal, subtotal);
          itemLandedCost = sumDecimal(itemTotal, mulDecimal(totalCosts, ratio));
        }

        const costPerBox = divDecimal(itemLandedCost, item.quantityBoxes);
        const costPerKg = item.totalNetWeightKg ? divDecimal(itemLandedCost, item.totalNetWeightKg) : toDecimal(0);

        await tx.purchaseItem.create({
          data: {
            purchaseId: purchase.id,
            productId: item.productId,
            quantityBoxes: item.quantityBoxes,
            totalNetWeightKg: toDecimal(item.totalNetWeightKg || 0),
            unit: item.unit,
            ratePerUnit: toDecimal(item.ratePerUnit),
            total: itemTotal,
            quality: item.quality
          }
        });

        const lotRef = generateLotReference(product.name, null, supplier.name, bDate);

        const lot = await tx.lot.create({
          data: {
            businessId,
            productId: item.productId,
            purchaseId: purchase.id,
            supplierId: dto.supplierId,
            lotReference: lotRef,
            receivedDate: bDate,
            totalBoxes: item.quantityBoxes,
            remainingBoxes: item.quantityBoxes,
            totalNetWeightKg: toDecimal(item.totalNetWeightKg || 0),
            remainingNetWeightKg: toDecimal(item.totalNetWeightKg || 0),
            purchaseCost: itemTotal,
            landedCost: itemLandedCost,
            costPerBox,
            costPerKg,
            status: LotStatus.ACTIVE,
            quality: item.quality
          }
        });

        await tx.inventoryMovement.create({
          data: {
            businessId,
            lotId: lot.id,
            productId: item.productId,
            movementType: InventoryMovementType.PURCHASE,
            quantityBoxes: item.quantityBoxes,
            quantityWeightKg: toDecimal(item.totalNetWeightKg || 0),
            transactionType: 'PURCHASE',
            transactionId: purchase.id,
            businessDate: bDate,
            costPerUnit: lot.costPerBox,
            totalCost: toDecimal(lot.costPerBox).times(item.quantityBoxes),
            notes: `Purchase ${purchaseRef}`,
          }
        });
      }

      return purchase;
    });
  }

  // B7: Purchase Return
  async processPurchaseReturn(businessId: string, dto: {
    purchaseId: string;
    items: Array<{ purchaseItemId: string; productId: string; quantity: number; reason: string }>;
    notes?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${dto.purchaseId} AND "businessId" = ${businessId} FOR UPDATE`;

      const purchase = await tx.purchase.findFirst({
        where: { id: dto.purchaseId, businessId },
        include: { items: true, supplier: true },
      });
      if (!purchase) throw new NotFoundException('Purchase not found');

      const returnRef = generateReference('ADJUSTMENT', new Date());
      const bDate = new Date();
      let totalReturnAmount = toDecimal(0);

      for (const returnItem of dto.items) {
        const origItem = purchase.items.find(i => i.id === returnItem.purchaseItemId);
        if (!origItem) throw new BadRequestException(`Purchase item ${returnItem.purchaseItemId} not found`);
        if (returnItem.quantity <= 0) throw new BadRequestException('Return quantity must be positive');
        if (returnItem.quantity > origItem.quantityBoxes) throw new BadRequestException('Return quantity exceeds purchased quantity');

        // Find the lot created for this purchase
        const lot = await tx.lot.findFirst({
          where: { purchaseId: purchase.id, productId: returnItem.productId, businessId },
        });
        if (!lot) throw new BadRequestException('Lot not found for this purchase item');
        if (lot.remainingBoxes < returnItem.quantity) throw new BadRequestException('Insufficient stock in lot for return');

        const returnCost = toDecimal(lot.costPerBox).times(returnItem.quantity);
        totalReturnAmount = sumDecimal(totalReturnAmount, returnCost);

        // Decrease inventory
        const newRemaining = lot.remainingBoxes - returnItem.quantity;
        await tx.lot.update({
          where: { id: lot.id },
          data: {
            remainingBoxes: newRemaining,
            status: newRemaining === 0 ? LotStatus.DEPLETED : lot.status,
          }
        });

        await tx.inventoryMovement.create({
          data: {
            businessId,
            lotId: lot.id,
            productId: returnItem.productId,
            movementType: InventoryMovementType.RETURN_TO_SUPPLIER,
            quantityBoxes: -returnItem.quantity,
            transactionType: 'PURCHASE_RETURN',
            transactionId: purchase.id,
            businessDate: bDate,
            costPerUnit: lot.costPerBox,
            totalCost: returnCost,
            notes: `Return: ${returnItem.reason}`,
          }
        });
      }

      // Adjust supplier payable. Not clamped at zero: if the purchase was
      // already fully paid, this goes negative — that negative value IS the
      // record of money the supplier now owes back to the business (see
      // PaymentsService.refundSupplier, the only way to record collecting it).
      if (totalReturnAmount.gt(0)) {
        const newCreditAmount = toDecimal(purchase.creditAmount).minus(totalReturnAmount);
        await tx.purchase.update({
          where: { id: purchase.id },
          data: { creditAmount: newCreditAmount }
        });

        // Post reversal ledger entry
        let payableAccount = await tx.account.findFirst({ where: { businessId, type: 'SUPPLIER_PAYABLE' } });
        if (payableAccount) {
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: payableAccount.id,
              transactionType: 'PURCHASE_RETURN',
              transactionId: purchase.id,
              entityType: 'SUPPLIER',
              entityId: purchase.supplierId,
              debit: totalReturnAmount,
              businessDate: bDate,
              description: `Purchase return for ${purchase.purchaseReference}`
            }
          });
        }

        await this.auditService.record(tx, {
          businessId,
          action: AuditAction.UPDATE,
          entityType: 'PURCHASE',
          entityId: purchase.id,
          before: { creditAmount: toMoneyString(purchase.creditAmount) },
          after: { creditAmount: toMoneyString(newCreditAmount) },
          reason: dto.notes || 'Purchase return',
        });

        if (newCreditAmount.lt(0)) {
          return {
            success: true,
            returnAmount: toMoneyString(totalReturnAmount),
            refundOwed: toMoneyString(newCreditAmount.abs()),
            message: 'Purchase was already fully paid \u2014 the supplier now owes the business a refund.',
          };
        }
      }

      return { success: true, returnAmount: toMoneyString(totalReturnAmount) };
    });
  }
}
