import { FreshnessStatus, LotStatus, MovementType, InventoryMovementType, AuditAction } from '../../common/enums.js';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service.js';
import { AdjustInventoryDto } from './dto/adjust-inventory.dto.js';
import { RecordWastageDto } from './dto/record-wastage.dto.js';
import { toDecimal, sumDecimal } from '../../common/utils/money.util.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class InventoryService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
  ) {}

  async getAllStock(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, active: true },
      include: {
        lots: {
          where: {
            status: LotStatus.ACTIVE,
            remainingBoxes: { gt: 0 }
          }
        }
      }
    });

    return products.map(product => {
      const remainingBoxes = product.lots.reduce((sum, lot) => sum + lot.remainingBoxes, 0);
      const remainingWeight = product.lots.reduce((sum, lot) => sumDecimal(sum, lot.remainingNetWeightKg).toNumber(), 0);
      const stockValue = product.lots.reduce((sum, lot) => {
        const val = toDecimal(lot.costPerBox).times(lot.remainingBoxes);
        return sumDecimal(sum, val).toNumber();
      }, 0);

      return {
        id: product.id,
        name: product.name,
        code: product.id,
        category: product.category,
        remainingBoxes,
        remainingWeight,
        stockValue: stockValue.toString(),
      };
    });
  }

  async getProductStock(businessId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
      include: {
        lots: {
          where: {
            status: LotStatus.ACTIVE,
            remainingBoxes: { gt: 0 }
          },
          orderBy: { freshnessScore: 'asc' }
        }
      }
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const remainingBoxes = product.lots.reduce((sum, lot) => sum + lot.remainingBoxes, 0);
    const remainingWeight = product.lots.reduce((sum, lot) => sumDecimal(sum, lot.remainingNetWeightKg).toNumber(), 0);

    return {
      product: {
        id: product.id,
        name: product.name,
        code: product.id,
      },
      summary: {
        remainingBoxes,
        remainingWeight,
      },
      lots: product.lots
    };
  }

  async getAtRiskLots(businessId: string) {
    return this.prisma.lot.findMany({
      where: {
        businessId,
        status: LotStatus.ACTIVE,
        remainingBoxes: { gt: 0 },
        freshnessStatus: {
          in: [
            FreshnessStatus.WATCH,
            FreshnessStatus.MARKDOWN,
            FreshnessStatus.URGENT,
            FreshnessStatus.LIKELY_LOSS
          ]
        }
      },
      include: {
        product: {
          select: { name: true, id: true }
        }
      },
      orderBy: { freshnessScore: 'asc' }
    });
  }

  async recordAdjustment(businessId: string, dto: AdjustInventoryDto, actingUserId?: string | null) {
    return this.recordMovement(businessId, {
      lotId: dto.lotId,
      quantityBoxes: dto.quantityBoxes,
      weightKg: dto.weightKg,
      movementType: InventoryMovementType.ADJUSTMENT,
      transactionId: dto.reason,
      notes: dto.reason,
      businessDate: dto.businessDate,
    }, actingUserId);
  }

  async recordWastage(businessId: string, dto: RecordWastageDto, actingUserId?: string | null) {
    return this.recordMovement(businessId, {
      lotId: dto.lotId,
      quantityBoxes: dto.quantityBoxes ? -Math.abs(dto.quantityBoxes) : undefined,
      weightKg: dto.weightKg ? `-${Math.abs(Number(dto.weightKg))}` : undefined,
      movementType: InventoryMovementType.WASTAGE,
      transactionId: dto.reason,
      notes: dto.reason,
      businessDate: dto.businessDate,
    }, actingUserId);
  }

  private async recordMovement(
    businessId: string,
    data: {
      lotId: string;
      quantityBoxes?: number;
      weightKg?: string;
      movementType: InventoryMovementType;
      transactionId: string;
      notes: string;
      businessDate?: string;
    },
    actingUserId?: string | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Phase 5: lock the lot row before reading its balance. Without this,
      // two concurrent adjustments/wastage entries on the same lot can both
      // read the same starting remainingBoxes/remainingNetWeightKg and both
      // succeed — a lost-update race that could also let stock go negative
      // despite the check below (each request checks against the same
      // stale balance). Same FOR UPDATE pattern used for sale/purchase
      // locking in payments.service.ts.
      await tx.$queryRaw`SELECT id FROM lots WHERE id = ${data.lotId} AND "businessId" = ${businessId} FOR UPDATE`;

      // Phase 9: this method had no closed-business-date check at all —
      // every other stock/money mutation (sales, purchases, payments,
      // expenses, transfers) rejects on a closed date; a wastage or
      // adjustment could silently slip through and change inventory (and
      // day-close's own already-recorded wastageTotal) for a date that's
      // supposedly locked. Same guard, same relative position (after the
      // row lock) as receivePayment/makePayment.
      const bDate = await assertBusinessDateOpen(tx, businessId, data.businessDate);

      const lot = await tx.lot.findFirst({
        where: { id: data.lotId, businessId }
      });

      if (!lot) {
        throw new NotFoundException('Lot not found');
      }

      const newRemainingBoxes = lot.remainingBoxes + (data.quantityBoxes || 0);
      const newRemainingWeight = sumDecimal(lot.remainingNetWeightKg, data.weightKg || '0');

      if (newRemainingBoxes < 0) {
        throw new BadRequestException('Adjustment would result in negative boxes');
      }

      // Phase 5: boxes were already protected from going negative, but kg
      // wasn't — a box can be recorded as fine while its weight silently
      // goes negative (lots don't all weigh the same per box).
      if (newRemainingWeight.lt(0)) {
        throw new BadRequestException('Adjustment would result in negative weight');
      }

      const updatedLot = await tx.lot.update({
        where: { id: lot.id },
        data: {
          remainingBoxes: newRemainingBoxes,
          remainingNetWeightKg: newRemainingWeight,
          status: newRemainingBoxes === 0 ? LotStatus.DEPLETED : lot.status
        }
      });

      const movement = await tx.inventoryMovement.create({
        data: {
          businessId,
          lotId: lot.id,
          productId: lot.productId,
          movementType: data.movementType,
          transactionType: data.movementType,
          transactionId: data.transactionId,
          quantityBoxes: data.quantityBoxes || 0,
          quantityWeightKg: toDecimal(data.weightKg || '0'),
          costPerUnit: lot.costPerBox,
          totalCost: toDecimal(lot.costPerBox).times(Math.abs(data.quantityBoxes || 0)),
          businessDate: bDate,
          notes: data.notes
        }
      });

      // B8 FIX: Post ledger entry for wastage loss
      if (data.movementType === InventoryMovementType.WASTAGE) {
        const lossAmount = toDecimal(lot.costPerBox).times(Math.abs(data.quantityBoxes || 0));
        if (lossAmount.gt(0)) {
          let expenseAccount = await tx.account.findFirst({
            where: { businessId, type: 'EXPENSE' }
          });
          if (!expenseAccount) {
            expenseAccount = await tx.account.create({
              data: { businessId, name: 'Wastage & Losses', type: 'EXPENSE' }
            });
          }
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: expenseAccount.id,
              transactionType: 'WASTAGE',
              transactionId: movement.id,
              entityType: 'LOT',
              entityId: lot.id,
              debit: lossAmount,
              businessDate: bDate,
              description: `Wastage loss: ${Math.abs(data.quantityBoxes || 0)} boxes from lot ${lot.lotReference} - ${data.notes}`
            }
          });

          // Phase 9: the loss was being recognized as an expense (debit)
          // with no corresponding credit anywhere — inventory value never
          // actually left the books, so the ledger was one-sided by
          // exactly the wastage amount every time. Mirrors sales.service.ts's
          // identical COGS-debit / INVENTORY_ASSET-credit pair for the
          // same underlying event (stock leaving for a non-revenue reason).
          let inventoryAccount = await tx.account.findFirst({
            where: { businessId, type: 'INVENTORY_ASSET' }
          });
          if (!inventoryAccount) {
            inventoryAccount = await tx.account.create({
              data: { businessId, name: 'Inventory Asset', type: 'INVENTORY_ASSET' }
            });
          }
          await tx.ledgerEntry.create({
            data: {
              businessId,
              accountId: inventoryAccount.id,
              transactionType: 'WASTAGE',
              transactionId: movement.id,
              entityType: 'LOT',
              entityId: lot.id,
              credit: lossAmount,
              businessDate: bDate,
              description: `Inventory deduction for wastage: ${Math.abs(data.quantityBoxes || 0)} boxes from lot ${lot.lotReference}`
            }
          });
        }
      }

      // Phase 5: audit entry for the lot quantity change, atomic with the
      // movement itself (same transaction) — was missing entirely before.
      await this.auditService.record(tx, {
        businessId,
        userId: actingUserId,
        action: AuditAction.UPDATE,
        entityType: 'LOT',
        entityId: lot.id,
        before: { remainingBoxes: lot.remainingBoxes, remainingNetWeightKg: lot.remainingNetWeightKg.toString() },
        after: { remainingBoxes: updatedLot.remainingBoxes, remainingNetWeightKg: updatedLot.remainingNetWeightKg.toString() },
        reason: data.notes,
      });

      return { lot: updatedLot, movement };
    });
  }
}
