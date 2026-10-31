import { Logger } from "@nestjs/common";
import type { Prisma } from "@atrium/database";
import type { PrismaService } from "../prisma/prisma.service";

const logger = new Logger("AuthAudit");

export interface AuthAuditEvent {
  action: string;
  userId?: string | null;
  email?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
  userAgent?: string | null;
}

type Db = Pick<PrismaService, "member" | "user" | "auditLog">;

/**
 * Account-level events (sign-in, 2FA changes) belong to a person rather than a
 * workspace, so they are written to every workspace the person is a member of,
 * where each workspace's owners can see them. Never throws.
 */
export async function recordAuthEvent(db: Db, event: AuthAuditEvent): Promise<void> {
  try {
    let userId = event.userId ?? null;
    let email = event.email ?? null;
    if (!userId && email) {
      const user = await db.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true, email: true },
      });
      if (!user) return; // unknown address: nothing to attribute it to
      userId = user.id;
      email = user.email;
    }
    if (!userId) return;
    const memberships = await db.member.findMany({ where: { userId }, select: { organizationId: true }, take: 20 });
    if (memberships.length === 0) return;
    await db.auditLog.createMany({
      data: memberships.map((m) => ({
        organizationId: m.organizationId,
        actorId: userId,
        actorEmail: email,
        action: event.action,
        targetType: "user",
        targetId: userId,
        summary: event.summary.slice(0, 500),
        metadata: event.metadata,
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent?.slice(0, 500) ?? null,
      })),
    });
  } catch (err) {
    logger.error(`Failed to record ${event.action}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A workspace-scoped entry from code that has no AuditService (Better Auth hooks). Never throws. */
export async function recordOrgEvent(
  db: Pick<PrismaService, "auditLog">,
  entry: {
    organizationId: string;
    actorId: string | null;
    actorEmail: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    summary: string;
    metadata?: Prisma.InputJsonValue;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: { ...entry, summary: entry.summary.slice(0, 500), userAgent: entry.userAgent?.slice(0, 500) ?? null },
    });
  } catch (err) {
    logger.error(`Failed to record ${entry.action}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Client address and agent of a Better Auth request, for audit entries. */
export function requestContext(request: Request | undefined): { ipAddress: string | null; userAgent: string | null } {
  if (!request) return { ipAddress: null, userAgent: null };
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ipAddress: forwarded || request.headers.get("x-real-ip") || null,
    userAgent: request.headers.get("user-agent"),
  };
}
