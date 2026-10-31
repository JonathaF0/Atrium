import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ClientDocsService } from "./client-docs.service";
import type { ClientDocActor } from "./client-docs.service";
import { CreateClientDocDto } from "./client-docs.dto";

type Row = Record<string, unknown>;
const actor: ClientDocActor = { userId: "staff-1", email: null, context: { ipAddress: null, userAgent: null } };

function build(scope: { companyId: string | null } = { companyId: "co-a" }) {
  const prisma = {
    company: { findFirst: mock((_a: unknown) => Promise.resolve({ id: "co-a" } as Row | null)) },
    clientDoc: {
      findMany: mock((_a: unknown) => Promise.resolve([{ id: "d1", updatedById: "staff-1", title: "Network" }] as Row[])),
      findFirst: mock((_a: unknown) => Promise.resolve(null as Row | null)),
      create: mock((a: { data: Row }) => Promise.resolve({ id: "d1", ...a.data })),
      update: mock((a: { data: Row }) => Promise.resolve({ id: "d1", companyId: "co-a", ...a.data })),
      delete: mock(() => Promise.resolve({})),
    },
    clientDocAttachment: { findFirst: mock((_a: unknown) => Promise.resolve(null as Row | null)) },
  };
  const audit = { record: mock((_e: unknown) => Promise.resolve()) };
  const storage = { remove: mock(() => Promise.resolve()) };
  const clientScope = { resolve: mock(() => Promise.resolve({ userId: "u1", companyId: scope.companyId, companyAdmin: false })) };
  const service = new ClientDocsService(prisma as never, audit as never, storage as never, clientScope as never);
  return { prisma, audit, service };
}

describe("ClientDocsService", () => {
  it("rejects bodies that contain a credential", async () => {
    const { prisma, service } = build();
    await expect(
      service.create("org", { companyId: "co-a", title: "Firewall", body: "Admin password: Winter2026" }, actor),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.clientDoc.create).not.toHaveBeenCalled();
  });

  it("rejects credentials added on update too", async () => {
    const { prisma, service } = build();
    prisma.clientDoc.findFirst.mockResolvedValueOnce({ id: "d1", title: "x", body: "" });
    await expect(service.update("org", "d1", { body: "pwd=abc123" }, actor)).rejects.toThrow(BadRequestException);
    expect(prisma.clientDoc.update).not.toHaveBeenCalled();
  });

  it("creates in a company of this workspace and audits", async () => {
    const { prisma, service, audit } = build();
    await service.create("org", { companyId: "co-a", title: "Network", body: "VLAN 10", vaultUrl: "https://vault.example.com/x" }, actor);
    const data = (prisma.clientDoc.create.mock.calls[0][0] as { data: Row }).data;
    expect(data).toMatchObject({ organizationId: "org", companyId: "co-a", section: "other", clientVisible: true });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "client_doc.created", targetType: "client_doc" }));
  });

  it("refuses a company from another workspace", async () => {
    const { prisma, service } = build();
    prisma.company.findFirst.mockResolvedValueOnce(null);
    await expect(service.create("org", { companyId: "co-x", title: "t" }, actor)).rejects.toThrow(BadRequestException);
  });

  it("portal users see only their company's client-visible docs", async () => {
    const { prisma, service } = build();
    const docs = await service.listMine("org", "u1");
    const where = (prisma.clientDoc.findMany.mock.calls[0][0] as { where: Row }).where;
    expect(where).toEqual({ organizationId: "org", companyId: "co-a", clientVisible: true });
    expect(docs[0]).not.toHaveProperty("updatedById");
  });

  it("portal users without a company see nothing", async () => {
    const { prisma, service } = build({ companyId: null });
    expect(await service.listMine("org", "u1")).toEqual([]);
    expect(prisma.clientDoc.findMany).not.toHaveBeenCalled();
    await expect(service.mineAttachment("org", "u1", "att")).rejects.toThrow(NotFoundException);
  });

  it("portal attachment downloads are scoped to the company's visible docs", async () => {
    const { prisma, service } = build();
    await expect(service.mineAttachment("org", "u1", "att")).rejects.toThrow(NotFoundException);
    const where = (prisma.clientDocAttachment.findFirst.mock.calls[0][0] as { where: Row }).where;
    expect(where).toEqual({ id: "att", organizationId: "org", doc: { companyId: "co-a", clientVisible: true } });
  });
});

describe("CreateClientDocDto", () => {
  async function errors(body: Row): Promise<string[]> {
    const result = await validate(plainToInstance(CreateClientDocDto, body));
    return result.map((e) => e.property);
  }

  it("requires an https vault URL", async () => {
    expect(await errors({ companyId: "c", title: "t", vaultUrl: "http://vault.example.com" })).toContain("vaultUrl");
    expect(await errors({ companyId: "c", title: "t", vaultUrl: "javascript:alert(1)" })).toContain("vaultUrl");
    expect(await errors({ companyId: "c", title: "t", vaultUrl: "https://vault.example.com/item/1" })).toEqual([]);
    expect(await errors({ companyId: "c", title: "t", vaultUrl: null })).toEqual([]);
  });

  it("only accepts known sections", async () => {
    expect(await errors({ companyId: "c", title: "t", section: "passwords" })).toContain("section");
    expect(await errors({ companyId: "c", title: "t", section: "network" })).toEqual([]);
  });
});
