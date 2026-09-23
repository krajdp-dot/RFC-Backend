import { ReceivablesService } from './receivables.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate } from '../../common/utils/date.util.js';

const TODAY = getBusinessDate();
function daysAgo(n: number): Date {
  return new Date(TODAY.getTime() - n * 24 * 60 * 60 * 1000);
}

describe('ReceivablesService', () => {
  let service: ReceivablesService;
  let fakePrisma: FakePrismaService;

  function build(seed: Partial<Record<string, any[]>>) {
    fakePrisma = new FakePrismaService(seed);
    service = new ReceivablesService(fakePrisma as any);
  }

  describe('getReceivablesSummary', () => {
    it('outstanding is Sale.creditAmount, not sales-minus-payments — a refund does not double count', async () => {
      // A customer refund (refundCustomer) creates a Payment row against the
      // same customerId as an ordinary collection. The old implementation
      // summed ALL Payment rows for a customer and subtracted that from
      // sales total, so a refund got treated as if it reduced what the
      // customer owes — the opposite of what a refund means. Sale.creditAmount
      // already nets this correctly (every mutation keeps it correct), so
      // it's summed directly instead.
      build({
        customer: [{ id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditTermsDays: 30 }],
        sale: [
          { id: 's1', businessId: 'biz_1', customerId: 'c1', creditAmount: '0', businessDate: TODAY },
        ],
        payment: [
          // A refund exists in the data, tied to this customer, but there is
          // no outstanding credit sale — outstanding must be 0, not negative.
          { id: 'p1', businessId: 'biz_1', transactionType: 'REFUND', customerId: 'c1', saleId: 's1', amount: '200', businessDate: TODAY },
        ],
      });
      const result = await service.getReceivablesSummary('biz_1');
      expect(result).toEqual([]);
    });

    it('only customers with outstanding > 0 are listed, sorted by outstanding descending', async () => {
      build({
        customer: [
          { id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditTermsDays: 30 },
          { id: 'c2', businessId: 'biz_1', name: 'Sharma Fruits', creditTermsDays: 30 },
          { id: 'c3', businessId: 'biz_1', name: 'Fully Paid Co', creditTermsDays: 30 },
        ],
        sale: [
          { id: 's1', businessId: 'biz_1', customerId: 'c1', creditAmount: '5000', businessDate: TODAY },
          { id: 's2', businessId: 'biz_1', customerId: 'c2', creditAmount: '12000', businessDate: TODAY },
          { id: 's3', businessId: 'biz_1', customerId: 'c3', creditAmount: '0', businessDate: TODAY },
        ],
      });
      const result = await service.getReceivablesSummary('biz_1');
      expect(result.map((r: any) => r.name)).toEqual(['Sharma Fruits', 'Rajesh Traders']);
      expect(result[0].outstanding).toBe('12000.00');
    });

    it('business isolation: a customer\u2019s outstanding never includes another business\u2019s sales', async () => {
      build({
        customer: [
          { id: 'c1', businessId: 'biz_A', name: 'A Customer', creditTermsDays: 30 },
        ],
        sale: [
          { id: 's1', businessId: 'biz_A', customerId: 'c1', creditAmount: '1000', businessDate: TODAY },
          { id: 's2', businessId: 'biz_B', customerId: 'c1', creditAmount: '999999', businessDate: TODAY },
        ],
      });
      const result = await service.getReceivablesSummary('biz_A');
      expect(result[0].outstanding).toBe('1000.00');
    });
  });

  describe('getAgingAnalysis', () => {
    it('buckets a sale as overdue once its age passes the customer\u2019s credit terms', async () => {
      build({
        customer: [{ id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditTermsDays: 7 }],
        sale: [
          { id: 's1', businessId: 'biz_1', customerId: 'c1', creditAmount: '10000', businessDate: daysAgo(10) },
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging.overdue).toBe('10000.00');
      expect(aging.overdueCount).toBe(1);
      expect(aging.current).toBe('0.00');
    });

    it('a customer with no creditTermsDays configured defaults to 30 days', async () => {
      build({
        customer: [{ id: 'c1', businessId: 'biz_1', name: 'No Terms Co', creditTermsDays: null }],
        sale: [
          { id: 's1', businessId: 'biz_1', customerId: 'c1', creditAmount: '5000', businessDate: daysAgo(20) },
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      // 20 days old, default 30-day terms — not yet overdue.
      expect(aging.overdue).toBe('0.00');
      expect(aging.month).toBe('5000.00');
    });

    it('due-soon and due-today are split correctly and never double-count an overdue amount', async () => {
      build({
        customer: [
          { id: 'c_today', businessId: 'biz_1', name: 'Due Today', creditTermsDays: 5 },
          { id: 'c_soon', businessId: 'biz_1', name: 'Due Soon', creditTermsDays: 10 },
          { id: 'c_overdue', businessId: 'biz_1', name: 'Overdue', creditTermsDays: 3 },
        ],
        sale: [
          { id: 's_today', businessId: 'biz_1', customerId: 'c_today', creditAmount: '1000', businessDate: daysAgo(5) },  // due in 0 days
          { id: 's_soon', businessId: 'biz_1', customerId: 'c_soon', creditAmount: '2000', businessDate: daysAgo(5) },    // due in 5 days
          { id: 's_overdue', businessId: 'biz_1', customerId: 'c_overdue', creditAmount: '3000', businessDate: daysAgo(10) }, // 7 days overdue
        ],
      });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging.dueTodayValue).toBe('1000.00');
      expect(aging.dueTodayCount).toBe(1);
      expect(aging.dueSoonValue).toBe('2000.00');
      expect(aging.dueSoonCount).toBe(1);
      expect(aging.overdue).toBe('3000.00');
      expect(aging.overdueCount).toBe(1);
      // total is every bucket combined, and no amount appears in more than one.
      expect(aging.total).toBe('6000.00');
    });

    it('an empty book returns real zeros for every field, not null', async () => {
      build({ customer: [{ id: 'c1', businessId: 'biz_1', name: 'No Debt Co', creditTermsDays: 30 }] });
      const aging = await service.getAgingAnalysis('biz_1');
      expect(aging).toEqual({
        current: '0.00', week2: '0.00', month: '0.00', overdue: '0.00', total: '0.00',
        overdueCount: 0, dueTodayValue: '0.00', dueTodayCount: 0, dueSoonValue: '0.00', dueSoonCount: 0,
      });
    });
  });
});
