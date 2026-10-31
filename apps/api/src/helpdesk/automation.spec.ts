import { describe, expect, it } from "bun:test";
import { conditionMatches, evaluateRules, parseActions, parseConditions, type AutomationSubject } from "./automation";

const ticket: AutomationSubject = {
  categoryId: "cat-security",
  priority: "normal",
  source: "email",
  companyId: "co1",
  subject: "Suspicious login alert",
  status: "new",
};

const rule = (id: string, conditions: unknown, actions: unknown) => ({ id, name: id, conditions, actions });

describe("conditions", () => {
  it("eq and neq compare case-insensitively", () => {
    expect(conditionMatches({ field: "source", op: "eq", value: "EMAIL" }, ticket)).toBe(true);
    expect(conditionMatches({ field: "priority", op: "neq", value: "normal" }, ticket)).toBe(false);
  });

  it("contains matches substrings and never an empty value", () => {
    expect(conditionMatches({ field: "subject", op: "contains", value: "login" }, ticket)).toBe(true);
    expect(conditionMatches({ field: "subject", op: "contains", value: "" }, ticket)).toBe(false);
  });

  it("treats a null field as empty", () => {
    expect(conditionMatches({ field: "companyId", op: "eq", value: "" }, { ...ticket, companyId: null })).toBe(true);
  });
});

describe("evaluateRules", () => {
  it("applies the actions of matching rules", () => {
    const out = evaluateRules(
      [rule("r1", [{ field: "categoryId", op: "eq", value: "cat-security" }], [{ type: "set_priority", value: "urgent" }, { type: "add_label", value: "l1" }])],
      ticket,
    );
    expect(out).toEqual({ priority: "urgent", labelIds: ["l1"], matchedRuleIds: ["r1"] });
  });

  it("requires every condition and matches with none", () => {
    const out = evaluateRules(
      [
        rule("r1", [{ field: "source", op: "eq", value: "email" }, { field: "priority", op: "eq", value: "high" }], [{ type: "set_status", value: "open" }]),
        rule("r2", [], [{ type: "assign", value: "u1" }]),
      ],
      ticket,
    );
    expect(out.status).toBeUndefined();
    expect(out.assigneeId).toBe("u1");
    expect(out.matchedRuleIds).toEqual(["r2"]);
  });

  it("evaluates in order against the changes of earlier rules", () => {
    const out = evaluateRules(
      [
        rule("r1", [{ field: "subject", op: "contains", value: "suspicious" }], [{ type: "set_priority", value: "high" }]),
        rule("r2", [{ field: "priority", op: "eq", value: "high" }], [{ type: "assign", value: "u2" }]),
      ],
      ticket,
    );
    expect(out.priority).toBe("high");
    expect(out.assigneeId).toBe("u2");
  });

  it("a later rule overrides an earlier value; labels are deduplicated", () => {
    const out = evaluateRules(
      [
        rule("r1", [], [{ type: "set_priority", value: "high" }, { type: "add_label", value: "l1" }]),
        rule("r2", [], [{ type: "set_priority", value: "low" }, { type: "add_label", value: "l1" }]),
      ],
      ticket,
    );
    expect(out.priority).toBe("low");
    expect(out.labelIds).toEqual(["l1"]);
  });

  it("skips malformed rules instead of failing", () => {
    const out = evaluateRules(
      [rule("bad", [{ field: "password", op: "eq", value: "x" }], [{ type: "set_priority", value: "high" }]), rule("bad2", [], [{ type: "set_priority", value: "extreme" }])],
      ticket,
    );
    expect(out.matchedRuleIds).toEqual([]);
  });
});

describe("rule validation", () => {
  it("parseConditions rejects unknown fields and ops", () => {
    expect(parseConditions([{ field: "subject", op: "contains", value: "x" }])).not.toBeNull();
    expect(parseConditions([{ field: "subject", op: "regex", value: "x" }])).toBeNull();
    expect(parseConditions("nope")).toBeNull();
  });

  it("parseActions validates values for priority and status", () => {
    expect(parseActions([{ type: "set_status", value: "resolved" }])).not.toBeNull();
    expect(parseActions([{ type: "set_status", value: "deleted" }])).toBeNull();
    expect(parseActions([])).toBeNull();
    expect(parseActions([{ type: "webhook", value: "http://x" }])).toBeNull();
  });
});
