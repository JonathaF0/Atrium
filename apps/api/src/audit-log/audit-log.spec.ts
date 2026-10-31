import { describe, expect, it, mock } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { AuditLogService, buildAuditWhere, retentionDays } from "./audit-log.service";
import { resolveAuditEntry } from "./audit.interceptor";
import type { PrismaService } from "../prisma/prisma.service";

describe("buildAuditWhere", () => {
  it("always scopes to the workspace and applies each filter", () => {
    expect(buildAuditWhere("org-1", {})).toEqual({ organizationId: "org-1" });
    expect(
      buildAuditWhere("org-1", { action: "Auth.", actorId: "u1", targetType: "invoice", targetId: "inv-1", from: "2026-03-01", to: "2026-03-31" }),
    ).toEqual({
      organizationId: "org-1",
      action: { startsWith: "auth." },
      actorId: "u1",
      targetType: "invoice",
      targetId: "inv-1",
      createdAt: { gte: new Date("2026-03-01"), lt: new Date("2026-04-01T00:00:00.000Z") },
    });
  });

  it("rejects an inverted date range", () => {
    expect(() => buildAuditWhere("org-1", { from: "2026-03-10", to: "2026-03-01" })).toThrow(BadRequestException);
  });
});

describe("retention", () => {
  it("defaults to a year and treats 0 as keep forever", () => {
    expect(retentionDays(undefined)).toBe(365);
    expect(retentionDays("")).toBe(365);
    expect(retentionDays("30")).toBe(30);
    expect(retentionDays("0")).toBe(0);
    expect(retentionDays("-5")).toBe(365);
  });

  it("deletes only entries older than the window, across workspaces", async () => {
    const deleteMany = mock(() => Promise.resolve({ count: 4 }));
    const service = new AuditLogService(
      { auditLog: { deleteMany } } as unknown as PrismaService,
      { get: () => "30" } as unknown as ConfigService,
    );
    const now = new Date("2026-06-30T00:00:00.000Z");
    expect(await service.prune(now)).toBe(4);
    expect(deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: new Date("2026-05-31T00:00:00.000Z") } } });
  });

  it("keeps everything when retention is 0", async () => {
    const deleteMany = mock(() => Promise.resolve({ count: 0 }));
    const service = new AuditLogService(
      { auditLog: { deleteMany } } as unknown as PrismaService,
      { get: () => "0" } as unknown as ConfigService,
    );
    expect(await service.prune()).toBe(0);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

describe("resolveAuditEntry", () => {
  const req = {
    params: { id: "inv-1" },
    body: { status: "cancelled" },
    query: {},
    headers: { "user-agent": "test-agent" },
    ip: "203.0.113.5",
    user: { id: "u1", email: "owner@example.com" },
    organization: { id: "org-1" },
  } as unknown as Request;

  it("records the actor, workspace, target and request context", () => {
    const entry = resolveAuditEntry(
      { action: (r) => ((r.body as { status: string }).status === "cancelled" ? "invoice.voided" : null), targetType: "invoice", summary: "Voided" },
      req,
      { id: "inv-1" },
    );
    expect(entry).toMatchObject({
      organizationId: "org-1",
      actorId: "u1",
      actorEmail: "owner@example.com",
      action: "invoice.voided",
      targetType: "invoice",
      targetId: "inv-1",
      summary: "Voided",
      ipAddress: "203.0.113.5",
      userAgent: "test-agent",
    });
  });

  it("skips when the action resolves to null or there is no workspace", () => {
    expect(resolveAuditEntry({ action: () => null, targetType: "invoice" }, req, undefined)).toBeNull();
    expect(resolveAuditEntry({ action: "x", targetType: "y" }, { ...req, organization: undefined } as unknown as Request, undefined)).toBeNull();
  });
});
