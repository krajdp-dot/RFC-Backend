import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';

/**
 * Any Prisma client capable of writing an audit_logs row: either the shared
 * PrismaService, or the `tx` handed to a `prisma.$transaction(async (tx) => ...)`
 * callback. Callers pass `tx` whenever the audit write must be atomic with
 * the mutation it describes (Phase 1 requirement) — a failed audit write
 * then rolls back the mutation too, since they're the same transaction.
 */
type AuditCapableClient = { auditLog: { create: (args: any) => Promise<any> } };

export interface AuditEntryInput {
  businessId: string;
  userId?: string | null;
  /** e.g. 'CREATE' | 'UPDATE' | 'DELETE' | 'REVERSE' (see AuditAction enum). */
  action: string;
  /** e.g. 'ACCOUNT', 'SALE', 'PURCHASE', 'LOT', 'DAY_CLOSE'. */
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one audit_logs row using the schema's real before/after/reason
   * columns (the previous implementation wrote a single `details` blob that
   * doesn't exist as a column at all — see the Phase 1 report).
   *
   * Pass the active transaction client as `client` whenever this call must
   * be atomic with the mutation it records; pass the injected PrismaService
   * (or use recordStandalone) for a standalone, non-transactional write.
   */
  async record(client: AuditCapableClient, entry: AuditEntryInput) {
    return client.auditLog.create({
      data: {
        businessId: entry.businessId,
        userId: entry.userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: entry.before === undefined ? undefined : (entry.before as any),
        after: entry.after === undefined ? undefined : (entry.after as any),
        reason: entry.reason ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  async recordStandalone(entry: AuditEntryInput) {
    return this.record(this.prisma, entry);
  }

  /** Preserves the old method name/signature so existing call sites (if any)
   * keep working, on top of the corrected schema-accurate write path. */
  async createAuditEntry(
    businessId: string,
    userId: string | null | undefined,
    action: string,
    entityType: string,
    entityId: string,
    details?: { before?: unknown; after?: unknown; reason?: string | null },
  ) {
    return this.record(this.prisma, {
      businessId,
      userId,
      action,
      entityType,
      entityId,
      before: details?.before,
      after: details?.after,
      reason: details?.reason,
    });
  }

  async findAll(businessId: string, entityType?: string, entityId?: string, pagination?: PaginationDto) {
    const where: any = { businessId };
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;

    const skip = pagination?.skip ?? 0;
    const take = pagination?.take ?? 50;

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip,
        take,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginatedResponse(data, total, pagination?.page || 1, pagination?.limit || take);
  }
}
