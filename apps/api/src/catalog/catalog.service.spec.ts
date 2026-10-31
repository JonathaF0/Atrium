import { beforeEach, describe, expect, it, mock } from "bun:test";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import { CatalogService } from "./catalog.service";
import { TaxRatesService } from "./tax-rates.service";

function makePrisma() {
  const prisma = {
    taxRate: {
      findMany: mock(() => Promise.resolve([])),
      findFirst: mock((): Promise<unknown> => Promise.resolve(null)),
      create: mock((args: { data: unknown }) => Promise.resolve({ id: "tr-1", ...(args.data as object) })),
      update: mock((args: { data: unknown }) => Promise.resolve({ id: "tr-1", ...(args.data as object) })),
      updateMany: mock(() => Promise.resolve({ count: 1 })),
      deleteMany: mock(() => Promise.resolve({ count: 1 })),
    },
    catalogItem: {
      findMany: mock(() => Promise.resolve([])),
      findFirst: mock((): Promise<unknown> => Promise.resolve(null)),
      count: mock(() => Promise.resolve(0)),
      create: mock((args: { data: unknown }) => Promise.resolve({ id: "ci-1", ...(args.data as object) })),
      update: mock((args: { data: unknown }) => Promise.resolve({ id: "ci-1", ...(args.data as object) })),
      delete: mock(() => Promise.resolve({})),
    },
    catalogBundleItem: { count: mock(() => Promise.resolve(0)) },
    catalogBundle: {
      create: mock(() => Promise.resolve({ id: "b-1", items: [] })),
      deleteMany: mock(() => Promise.resolve({ count: 0 })),
    },
    $transaction: mock((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return prisma;
}

describe("TaxRatesService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TaxRatesService;
  beforeEach(() => {
    prisma = makePrisma();
    service = new TaxRatesService(prisma as unknown as PrismaService);
  });

  it("clears the previous default when creating a new default rate", async () => {
    await service.create("org-1", { name: " Sales tax ", rateBps: 825, isDefault: true });
    expect(prisma.taxRate.updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", isDefault: true },
      data: { isDefault: false },
    });
    const created = prisma.taxRate.create.mock.calls[0][0] as { data: { name: string; isDefault: boolean } };
    expect(created.data.name).toBe("Sales tax");
    expect(created.data.isDefault).toBe(true);
  });

  it("does not touch other rates for a non-default rate", async () => {
    await service.create("org-1", { name: "Reduced", rateBps: 500 });
    expect(prisma.taxRate.updateMany).not.toHaveBeenCalled();
  });

  it("maps a duplicate name to a conflict", async () => {
    prisma.taxRate.create.mockImplementationOnce(() => {
      const err = Object.assign(new Error("dup"), { code: "P2002" });
      return Promise.reject(err);
    });
    await expect(service.create("org-1", { name: "Dup", rateBps: 1 })).rejects.toThrow(ConflictException);
  });

  it("archiving a rate also drops its default flag", async () => {
    prisma.taxRate.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ id: "tr-1", organizationId: "org-1", isDefault: true, archivedAt: null }),
    );
    await service.update("org-1", "tr-1", { archived: true });
    const data = (prisma.taxRate.update.mock.calls[0][0] as { data: { isDefault?: boolean; archivedAt: Date } }).data;
    expect(data.isDefault).toBe(false);
    expect(data.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses to update a rate from another workspace", async () => {
    await expect(service.update("org-2", "tr-1", { name: "x" })).rejects.toThrow(NotFoundException);
  });

  it("returns 0 when no default rate exists", async () => {
    expect(await service.defaultRateBps("org-1")).toBe(0);
  });
});

describe("CatalogService", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: CatalogService;
  beforeEach(() => {
    prisma = makePrisma();
    service = new CatalogService(prisma as unknown as PrismaService);
  });

  it("drops the interval for non-recurring items and defaults the unit", async () => {
    await service.createItem("org-1", {
      name: "Setup",
      billingType: "hourly",
      recurringInterval: "monthly",
      rateCents: 12000,
    });
    const data = (prisma.catalogItem.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.recurringInterval).toBeNull();
    expect(data.unit).toBe("hour");
    expect(data.organizationId).toBe("org-1");
  });

  it("defaults recurring items to monthly", async () => {
    await service.createItem("org-1", { name: "Backup", billingType: "recurring", rateCents: 5000 });
    const data = (prisma.catalogItem.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.recurringInterval).toBe("monthly");
  });

  it("scopes searches to the workspace and excludes archived items", async () => {
    await service.listItems("org-1", { search: "net", page: 1, limit: 20 });
    const where = (prisma.catalogItem.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.organizationId).toBe("org-1");
    expect(where.archivedAt).toBeNull();
    expect(where.OR).toBeDefined();
  });

  it("rejects bundle items that belong to another workspace", async () => {
    prisma.catalogItem.count.mockImplementationOnce(() => Promise.resolve(1));
    await expect(
      service.createBundle("org-1", {
        name: "Starter",
        items: [
          { catalogItemId: "a", quantity: 1 },
          { catalogItemId: "b", quantity: 2 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses to delete an item used in a bundle", async () => {
    prisma.catalogItem.findFirst.mockImplementationOnce(() => Promise.resolve({ id: "ci-1", organizationId: "org-1" }));
    prisma.catalogBundleItem.count.mockImplementationOnce(() => Promise.resolve(2));
    await expect(service.removeItem("org-1", "ci-1")).rejects.toThrow(ConflictException);
  });
});
