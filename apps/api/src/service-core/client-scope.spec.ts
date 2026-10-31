import { describe, expect, it } from "bun:test";
import { clientCanSee, clientOwnedWhere } from "./client-scope.service";
import type { ClientScope } from "./client-scope.service";

const base: ClientScope = {
  userId: "u1",
  organizationId: "org",
  contactId: "c1",
  companyId: "co1",
  companyAdmin: false,
  email: "a@example.com",
  name: "A",
};

describe("clientOwnedWhere", () => {
  it("limits a regular client to their own records", () => {
    expect(clientOwnedWhere(base, "requesterUserId")).toEqual({ OR: [{ requesterUserId: "u1" }] });
  });

  it("adds the company for a company admin", () => {
    expect(clientOwnedWhere({ ...base, companyAdmin: true }, "requesterUserId")).toEqual({
      OR: [{ requesterUserId: "u1" }, { companyId: "co1" }],
    });
  });
});

describe("clientCanSee", () => {
  it("allows own records and, for admins, company records only", () => {
    expect(clientCanSee(base, "u1", null)).toBe(true);
    expect(clientCanSee(base, "u2", "co1")).toBe(false);
    expect(clientCanSee({ ...base, companyAdmin: true }, "u2", "co1")).toBe(true);
    expect(clientCanSee({ ...base, companyAdmin: true }, "u2", "co2")).toBe(false);
    expect(clientCanSee({ ...base, companyAdmin: true, companyId: null }, "u2", null)).toBe(false);
  });
});
