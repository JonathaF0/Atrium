import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { Prisma } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntry {
  organizationId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Minimal request shape the audit helpers read; keeps services free of Express types. */
export interface AuditRequestContext {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export function auditContext(req: AuditRequestContext | undefined): { ipAddress: string | null; userAgent: string | null } {
  if (!req) return { ipAddress: null, userAgent: null };
  const ua = req.headers?.["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: (Array.isArray(ua) ? ua[0] : ua)?.slice(0, 500) ?? null,
  };
}

@Injectable()
export class AuditService {
  constructor(
    private prisma: PrismaService,
    @InjectPinoLogger(AuditService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Records a sensitive action. Never throws: a failed audit write is logged
   * rather than failing the action it describes.
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    try {
      await client.auditLog.create({
        data: {
          organizationId: entry.organizationId,
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          summary: entry.summary?.slice(0, 500),
          metadata: entry.metadata,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (err) {
      if (tx) throw err;
      this.logger.error({ err, action: entry.action }, "Failed to write audit log entry");
    }
  }
}
