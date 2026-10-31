import {
  AUTOMATION_ACTIONS,
  AUTOMATION_FIELDS,
  AUTOMATION_OPS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type AutomationAction,
  type AutomationCondition,
} from "@atrium/shared";

/** The ticket fields rules can read. */
export interface AutomationSubject {
  categoryId: string | null;
  priority: string;
  source: string;
  companyId: string | null;
  subject: string;
  status: string;
}

export interface RuleLike {
  id: string;
  name: string;
  conditions: unknown;
  actions: unknown;
}

/** Changes produced by the rules, applied by the caller in one update. */
export interface AutomationOutcome {
  priority?: string;
  status?: string;
  categoryId?: string;
  assigneeId?: string;
  labelIds: string[];
  matchedRuleIds: string[];
}

const MAX_RULE_ITEMS = 20;

export function parseConditions(raw: unknown): AutomationCondition[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_RULE_ITEMS) return null;
  const out: AutomationCondition[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") return null;
    const { field, op, value } = c as Record<string, unknown>;
    if (!(AUTOMATION_FIELDS as readonly unknown[]).includes(field)) return null;
    if (!(AUTOMATION_OPS as readonly unknown[]).includes(op)) return null;
    if (typeof value !== "string" || value.length > 500) return null;
    out.push({ field, op, value } as AutomationCondition);
  }
  return out;
}

export function parseActions(raw: unknown): AutomationAction[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RULE_ITEMS) return null;
  const out: AutomationAction[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return null;
    const { type, value } = a as Record<string, unknown>;
    if (!(AUTOMATION_ACTIONS as readonly unknown[]).includes(type)) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
    if (type === "set_priority" && !(TICKET_PRIORITIES as readonly string[]).includes(value)) return null;
    if (type === "set_status" && !(TICKET_STATUSES as readonly string[]).includes(value)) return null;
    out.push({ type, value } as AutomationAction);
  }
  return out;
}

export function conditionMatches(cond: AutomationCondition, ticket: AutomationSubject): boolean {
  const actual: string = (ticket[cond.field] ?? "").toString();
  switch (cond.op) {
    case "eq":
      return actual.toLowerCase() === cond.value.toLowerCase();
    case "neq":
      return actual.toLowerCase() !== cond.value.toLowerCase();
    case "contains":
      return cond.value.length > 0 && actual.toLowerCase().includes(cond.value.toLowerCase());
  }
}

/**
 * Runs rules in order against a working copy of the ticket, so a later rule
 * sees what an earlier one changed. All conditions of a rule must match (an
 * empty list always matches). Rules run once per trigger: applying the outcome
 * never fires another round of rules.
 */
export function evaluateRules(rules: RuleLike[], ticket: AutomationSubject): AutomationOutcome {
  const working: AutomationSubject = { ...ticket };
  const outcome: AutomationOutcome = { labelIds: [], matchedRuleIds: [] };
  for (const rule of rules) {
    const conditions = parseConditions(rule.conditions);
    const actions = parseActions(rule.actions);
    if (!conditions || !actions) continue;
    if (!conditions.every((c) => conditionMatches(c, working))) continue;
    outcome.matchedRuleIds.push(rule.id);
    for (const action of actions) {
      switch (action.type) {
        case "set_priority":
          outcome.priority = working.priority = action.value;
          break;
        case "set_status":
          outcome.status = working.status = action.value;
          break;
        case "set_category":
          outcome.categoryId = working.categoryId = action.value;
          break;
        case "assign":
          outcome.assigneeId = action.value;
          break;
        case "add_label":
          if (!outcome.labelIds.includes(action.value)) outcome.labelIds.push(action.value);
          break;
      }
    }
  }
  return outcome;
}
