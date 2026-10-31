import { describe, expect, it } from "bun:test";
import { assetsToCsv, parseAssetMapping, planAssetImport, suggestMapping } from "./asset-csv";
import { parseCsv } from "../contacts/contacts-csv";

describe("suggestMapping", () => {
  it("recognises common header spellings and skips the rest", () => {
    expect(suggestMapping(["Company", "Asset Type", "Hostname", "Serial No", "Warranty End", "Shoe size"])).toEqual({
      Company: "company",
      "Asset Type": "type",
      Hostname: "name",
      "Serial No": "serialNumber",
      "Warranty End": "warrantyEndsAt",
      "Shoe size": "skip",
    });
  });
});

describe("parseAssetMapping", () => {
  it("accepts only known fields", () => {
    expect(parseAssetMapping('{"A":"name"}')).toEqual({ A: "name" });
    expect(parseAssetMapping('{"A":"password"}')).toBeNull();
    expect(parseAssetMapping("[]")).toBeNull();
    expect(parseAssetMapping("nope")).toBeNull();
  });
});

describe("planAssetImport", () => {
  const headers = ["Company", "Type", "Name", "Serial", "Renews", "Seats"];
  const mapping = suggestMapping(headers);

  it("builds drafts and skips invalid rows with a reason", () => {
    const rows = [
      ["Sample Company", "License", "Office suite", "", "2027-01-01", "25"],
      ["", "device", "No company", "", "", ""],
      ["Sample Company", "rocket", "Odd", "", "", ""],
      ["Sample Company", "device", "Bad date", "", "01/02/2027", ""],
      ["Sample Company", "", "Defaults to other", "SN-1", "", ""],
    ];
    const plan = planAssetImport(headers, rows, mapping);
    expect(plan[0]).toMatchObject({ row: 2, draft: { type: "software_license", seats: 25, name: "Office suite" } });
    expect(plan[1]).toEqual({ row: 3, skip: "No company" });
    expect(plan[2]).toMatchObject({ row: 4, skip: expect.stringContaining("Unknown type") });
    expect(plan[3]).toMatchObject({ row: 5, skip: expect.stringContaining("Invalid date") });
    expect(plan[4]).toMatchObject({ draft: { type: "other", serialNumber: "SN-1" } });
  });
});

describe("assetsToCsv", () => {
  it("round-trips through the importer's header detection", () => {
    const csv = assetsToCsv([
      {
        id: "a1",
        type: "domain",
        name: "example.com",
        vendor: null,
        model: null,
        serialNumber: null,
        assignedTo: null,
        status: "active",
        seats: null,
        purchaseDate: null,
        warrantyEndsAt: null,
        renewsAt: new Date("2027-03-01T00:00:00Z"),
        notes: "=cmd",
        externalSource: null,
        externalId: null,
        clientVisible: true,
        company: { name: "Sample Company" },
      },
    ]);
    const [headers, row] = parseCsv(csv);
    expect(row).toContain("2027-03-01");
    expect(row).toContain("'=cmd");
    const plan = planAssetImport(headers, [row], suggestMapping(headers));
    expect(plan[0]).toMatchObject({ draft: { company: "Sample Company", type: "domain", name: "example.com" } });
  });
});
