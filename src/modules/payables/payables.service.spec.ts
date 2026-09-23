import { PayablesService } from './payables.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate } from '../../common/utils/date.util.js';

const TODAY = getBusinessDate();
function daysAgo(n: number): Date {
  return new Date(TODAY.getTime() - n * 24 * 60 * 60 * 1000);
}

describe('PayablesService', () => {
  let service: PayablesService;
  let fakePrisma: FakePrismaService;

  function build(seed: Partial<Record<string, any[]>>) {
    fakePrisma = new FakePrismaService(seed);
    service = new PayablesService(fakePrisma as any);
  }

  describe('getPayablesSummary', () => {
    it('outstanding is Purchase.creditAmount, not purchases-minus-payments — a supplier refund does not double count', async () => {
      build({
        supplier: [{ id: 's1', businessId: 'biz_1', name: 'Merchant A', paymentTermsDays: 30 }],
        purchase: [
          { id: 'pu1', businessId: 'biz_1', supplierId: 's1', creditAmount: '0', businessDate: TODAY },
        ],
        payment: [
          { id: 'p1', businessId: 'biz_1', transactionType: 'REFUND', supplierId: 's1', purchaseId: 'pu1', amount: '500', businessDate: TODAY },
        ],
      });
      const result = await service.getPayablesSummary('biz_1');
      expect(result).toEqual([]);
    });

    it('only suppliers with outstanding > 0 are listed, sorted by outstanding descending', async () => {
      build({
        supplier: [
          { id: 's1', businessId: 'biz_1', name: 'Merchant A', paymentTermsDays: 30 },
          { id: 's2', businessId: 'biz_1', name: 'Merchant B', paymentTermsDays: 30 },
        ],
        purchase: [
          { id: 'pu1', businessId: 'biz_1', supplierId: 's1', creditAmount: '8000', businessDate: TODAY },
          { id: 'pu2', businessId: 'biz_1', supplierId: 's2', creditAmount: '20000', businessDate: TODAY },
        ],
      });
      const result = await service.getPayablesSummary('biz_1');
      expect(result.map((r: any) => r.name)).toEqual(['Merchant B', 'Merchant A']);
    });
  });

  describe('getAgingAnalysis', () => {
    it('buckets a purchase as overdue once its age passes the supplier\u2019s payment terms', async () => {
      build({
        supplier: [{ id: 's1', businessId: 'biz_1', name: 'Merchant A', paymentTermsDays: 15 }],
        purchase: [
          { id: 'pu1', businessId: 'biz_1', supplierId: 's1', creditAmount: '20000', businessDate: daysAgo(20) },
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging.overdue).toBe('20000.00');
      expect(aging.overdueCount).toBe(1);
    });

    it('due today and due this week never overlap, and together they equal the near-term total', async () => {
      build({
        supplier: [
          { id: 's_today', businessId: 'biz_1', name: 'Due Today Co', paymentTermsDays: 7 },
          { id: 's_week', businessId: 'biz_1', name: 'Due This Week Co', paymentTermsDays: 7 },
        ],
        purchase: [
          { id: 'pu_today', businessId: 'biz_1', supplierId: 's_today', creditAmount: '4000', businessDate: daysAgo(7) }, // due in 0 days
          { id: 'pu_week', businessId: 'biz_1', supplierId: 's_week', creditAmount: '6000', businessDate: daysAgo(4) },   // due in 3 days
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging.dueTodayValue).toBe('4000.00');
      expect(aging.dueSoonValue).toBe('6000.00');
      expect(aging.overdue).toBe('0.00');
      expect(aging.total).toBe('10000.00');
    });

    it('a supplier with no paymentTermsDays configured defaults to 30 days', async () => {
      build({
        supplier: [{ id: 's1', businessId: 'biz_1', name: 'No Terms Supplier', paymentTermsDays: null }],
        purchase: [
          { id: 'pu1', businessId: 'biz_1', supplierId: 's1', creditAmount: '3000', businessDate: daysAgo(25) },
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging.overdue).toBe('0.00');
      expect(aging.month).toBe('3000.00');
    });
  });
});
