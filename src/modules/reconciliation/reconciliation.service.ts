import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toMoneyString, toDecimal, sumDecimal } from '../../common/utils/money.util.js';
import { CashReconciliationDto, InventoryReconciliationDto } from './dto/reconciliation.dto.js';

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async reconcileCash(businessId: string, data: CashReconciliationDto) {
    const account = await this.prisma.account.findFirst({
      where: { id: data.accountId, businessId },
    });
    if (!account) throw new NotFoundException('Account not found');

    // Compute expected balance: openingBalance + sum(debits) - sum(credits)
    const ledgerAggr = await this.prisma.ledgerEntry.aggregate({
      where: { businessId, accountId: data.accountId },
      _sum: { debit: true, credit: true },
    });

    const opening = toDecimal(account.openingBalance);
    const totalDebits = toDecimal(ledgerAggr._sum.debit);
    const totalCredits = toDecimal(ledgerAggr._sum.credit);
    const expected = opening.plus(totalDebits).minus(totalCredits);

    const difference = toDecimal(data.physicalAmount).minus(expected);

    return {
      accountId: data.accountId,
      accountName: account.name,
      openingBalance: toMoneyString(opening),
      totalDebits: toMoneyString(totalDebits),
      totalCredits: toMoneyString(totalCredits),
      expected: toMoneyString(expected),
      physical: toMoneyString(data.physicalAmount),
      difference: toMoneyString(difference),
      status: difference.isZero() ? 'MATCHED' : 'DISCREPANCY',
    };
  }

  async reconcileInventory(businessId: string, data: InventoryReconciliationDto) {
    const lots = await this.prisma.lot.findMany({
      where: { productId: data.productId, businessId, status: { not: 'DEPLETED' } },
    });
    
    const expectedBoxes = lots.reduce((sum, l) => sum + l.remainingBoxes, 0);
    const expectedWeight = lots.reduce((sum, l) => sumDecimal(sum, l.remainingNetWeightKg).toNumber(), 0);
    const boxDifference = data.physicalBoxes - expectedBoxes;
    const weightDifference = data.physicalWeightKg != null
      ? data.physicalWeightKg - expectedWeight
      : null;

    return {
      productId: data.productId,
      expectedBoxes,
      physicalBoxes: data.physicalBoxes,
      boxDifference,
      expectedWeight,
      physicalWeight: data.physicalWeightKg ?? null,
      weightDifference,
      status: boxDifference === 0 ? 'MATCHED' : 'DISCREPANCY',
    };
  }

  // B5 FIX: Real data integrity verification
  async getVerification(businessId: string) {
    const checks = await Promise.all([
      this.checkCustomerOutstanding(businessId),
      this.checkSupplierPayable(businessId),
      this.checkAccountBalances(businessId),
      this.checkInventoryQuantities(businessId),
    ]);

    return { integrityChecks: checks };
  }

  private async checkCustomerOutstanding(businessId: string) {
    // Sum of Sale.creditAmount where creditAmount > 0
    const salesAggr = await this.prisma.sale.aggregate({
      where: { businessId, creditAmount: { gt: 0 } },
      _sum: { creditAmount: true },
    });
    const saleCreditTotal = toDecimal(salesAggr._sum.creditAmount);

    // Sum of debit entries in CUSTOMER_RECEIVABLE accounts
    const receivableAccounts = await this.prisma.account.findMany({
      where: { businessId, type: 'CUSTOMER_RECEIVABLE' },
      select: { id: true },
    });
    const accountIds = receivableAccounts.map(a => a.id);

    let ledgerTotal = toDecimal(0);
    if (accountIds.length > 0) {
      const ledgerAggr = await this.prisma.ledgerEntry.aggregate({
        where: { businessId, accountId: { in: accountIds } },
        _sum: { debit: true, credit: true },
      });
      ledgerTotal = toDecimal(ledgerAggr._sum.debit).minus(toDecimal(ledgerAggr._sum.credit));
    }

    const diff = saleCreditTotal.minus(ledgerTotal).abs();
    const discrepancies: string[] = [];
    if (diff.gt(1)) {
      discrepancies.push(
        `Sales credit total ${toMoneyString(saleCreditTotal)} vs ledger receivable net ${toMoneyString(ledgerTotal)} (diff: ${toMoneyString(diff)})`
      );
    }

    return {
      name: 'Customer Outstanding',
      status: discrepancies.length === 0 ? 'PASS' : 'WARN',
      salesCreditTotal: toMoneyString(saleCreditTotal),
      ledgerReceivableNet: toMoneyString(ledgerTotal),
      discrepancies,
    };
  }

  private async checkSupplierPayable(businessId: string) {
    // Sum of Purchase.creditAmount where creditAmount > 0
    const purchaseAggr = await this.prisma.purchase.aggregate({
      where: { businessId, creditAmount: { gt: 0 } },
      _sum: { creditAmount: true },
    });
    const purchaseCreditTotal = toDecimal(purchaseAggr._sum.creditAmount);

    // Sum of credit entries in SUPPLIER_PAYABLE accounts
    const payableAccounts = await this.prisma.account.findMany({
      where: { businessId, type: 'SUPPLIER_PAYABLE' },
      select: { id: true },
    });
    const accountIds = payableAccounts.map(a => a.id);

    let ledgerTotal = toDecimal(0);
    if (accountIds.length > 0) {
      const ledgerAggr = await this.prisma.ledgerEntry.aggregate({
        where: { businessId, accountId: { in: accountIds } },
        _sum: { debit: true, credit: true },
      });
      ledgerTotal = toDecimal(ledgerAggr._sum.credit).minus(toDecimal(ledgerAggr._sum.debit));
    }

    const diff = purchaseCreditTotal.minus(ledgerTotal).abs();
    const discrepancies: string[] = [];
    if (diff.gt(1)) {
      discrepancies.push(
        `Purchase credit total ${toMoneyString(purchaseCreditTotal)} vs ledger payable net ${toMoneyString(ledgerTotal)} (diff: ${toMoneyString(diff)})`
      );
    }

    return {
      name: 'Supplier Payable',
      status: discrepancies.length === 0 ? 'PASS' : 'WARN',
      purchaseCreditTotal: toMoneyString(purchaseCreditTotal),
      ledgerPayableNet: toMoneyString(ledgerTotal),
      discrepancies,
    };
  }

  private async checkAccountBalances(businessId: string) {
    // For each CASH/BANK/DIGITAL account, verify opening + ledger = consistent
    const accounts = await this.prisma.account.findMany({
      where: { businessId, type: { in: ['CASH', 'BANK', 'DIGITAL'] } },
    });

    const discrepancies: string[] = [];
    for (const account of accounts) {
      const ledgerAggr = await this.prisma.ledgerEntry.aggregate({
        where: { businessId, accountId: account.id },
        _sum: { debit: true, credit: true },
      });
      const balance = toDecimal(account.openingBalance)
        .plus(toDecimal(ledgerAggr._sum.debit))
        .minus(toDecimal(ledgerAggr._sum.credit));

      // Flag if balance goes negative (shouldn't for cash accounts)
      if (balance.lt(0)) {
        discrepancies.push(
          `Account "${account.name}" has negative computed balance: ${toMoneyString(balance)}`
        );
      }
    }

    return {
      name: 'Account Balances',
      status: discrepancies.length === 0 ? 'PASS' : 'WARN',
      discrepancies,
    };
  }

  private async checkInventoryQuantities(businessId: string) {
    // Compare Lot.remainingBoxes totals vs net InventoryMovement sums per product
    const products = await this.prisma.product.findMany({
      where: { businessId, active: true },
      select: { id: true, name: true },
    });

    const discrepancies: string[] = [];
    for (const product of products) {
      // Sum of lot remaining boxes
      const lotAggr = await this.prisma.lot.aggregate({
        where: { businessId, productId: product.id, status: { not: 'DEPLETED' } },
        _sum: { remainingBoxes: true },
      });
      const lotBoxes = lotAggr._sum.remainingBoxes || 0;

      // Sum of all inventory movements for this product
      const movAggr = await this.prisma.inventoryMovement.aggregate({
        where: { businessId, productId: product.id },
        _sum: { quantityBoxes: true },
      });
      const movementNet = movAggr._sum.quantityBoxes || 0;

      // They should be equal (movements track the delta, lot remaining is current state)
      // But movements are cumulative from start, lots track current remaining
      // A discrepancy means lot remaining drifted from movement totals
      if (lotBoxes !== movementNet && Math.abs(lotBoxes - movementNet) > 0) {
        discrepancies.push(
          `Product "${product.name}" lot remaining: ${lotBoxes}, movement net: ${movementNet} (diff: ${lotBoxes - movementNet})`
        );
      }
    }

    return {
      name: 'Inventory Quantities',
      status: discrepancies.length === 0 ? 'PASS' : 'WARN',
      discrepancies,
    };
  }
}
