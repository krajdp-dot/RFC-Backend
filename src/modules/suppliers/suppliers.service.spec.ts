import { SuppliersService } from './suppliers.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate } from '../../common/utils/date.util.js';

const TODAY = getBusinessDate();

describe('SuppliersService.getSupplierSummary', () => {
  function build(seed: Partial<Record<string, any[]>>) {
    const fakePrisma = new FakePrismaService(seed);
    return { service: new SuppliersService(fakePrisma as any), fakePrisma };
  }

  it('outstanding reflects unpaid credit purchases (landedCost-based), not subtotal minus every payment', async () => {
    const { service } = build({
      supplier: [{ id: 's1', businessId: 'biz_1', name: 'Merchant A' }],
      purchase: [
        // subtotal 100000, landedCost 115000 (after transport/loading),
        // creditAmount 20000 still owed — the old formula (subtotal - paid)
        // would get this wrong twice over.
        { id: 'pu1', businessId: 'biz_1', supplierId: 's1', subtotal: '100000', landedCost: '115000', creditAmount: '20000', status: 'COMPLETED' },
      ],
    });
    const summary = await service.getSupplierSummary('biz_1', 's1');
    expect(summary.outstanding).toBe('20000.00');
  });

  it('totalPaid counts supplier payments, not a refund the supplier paid back', async () => {
    const { service } = build({
      supplier: [{ id: 's1', businessId: 'biz_1', name: 'Merchant A' }],
      purchase: [
        { id: 'pu1', businessId: 'biz_1', supplierId: 's1', subtotal: '10000', landedCost: '10000', creditAmount: '0', status: 'COMPLETED' },
      ],
      payment: [
        { id: 'p1', businessId: 'biz_1', supplierId: 's1', transactionType: 'SUPPLIER_PAYMENT', amount: '10000', status: 'COMPLETED', businessDate: TODAY },
        { id: 'p2', businessId: 'biz_1', supplierId: 's1', transactionType: 'REFUND', amount: '1500', status: 'COMPLETED', businessDate: TODAY },
      ],
    });
    const summary = await service.getSupplierSummary('biz_1', 's1');
    expect(summary.totalPaid).toBe('10000.00');
  });

  it('business isolation: another business\u2019s purchases never count toward this supplier\u2019s outstanding', async () => {
    const { service } = build({
      supplier: [{ id: 's1', businessId: 'biz_A', name: 'A Merchant' }],
      purchase: [
        { id: 'pu1', businessId: 'biz_A', supplierId: 's1', subtotal: '1000', landedCost: '1000', creditAmount: '1000', status: 'COMPLETED' },
        { id: 'pu2', businessId: 'biz_B', supplierId: 's1', subtotal: '999999', landedCost: '999999', creditAmount: '999999', status: 'COMPLETED' },
      ],
    });
    const summary = await service.getSupplierSummary('biz_A', 's1');
    expect(summary.outstanding).toBe('1000.00');
  });
});
