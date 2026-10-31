import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AutomationRule, Ticket } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../service-core";
import { evaluateRules, parseActions, parseConditions, type AutomationOutcome } from "./automation";
import type { AutomationRuleDto, UpdateAutomationRuleDto } from "./helpdesk.dto";

const MAX_RULES = 100;

@Injectable()
export class AutomationService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** The combined outcome of the enabled rules for this trigger, or null when none matched. */
  async evaluate(
    trigger: "ticket_created" | "ticket_updated",
    ticket: Ticket,
  ): Promise<{ outcome: AutomationOutcome; ruleNames: string[] } | null> {
    const rules = await this.prisma.automationRule.findMany({
      where: { organizationId: ticket.organizationId, trigger, enabled: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      take: MAX_RULES,
    });
    if (rules.length === 0) return null;
    const outcome: AutomationOutcome = evaluateRules(rules, ticket);
    if (outcome.matchedRuleIds.length === 0) return null;
    const names: string[] = rules.filter((r) => outcome.matchedRuleIds.includes(r.id)).map((r) => r.name);
    return { outcome, ruleNames: names };
  }

  list(orgId: string): Promise<AutomationRule[]> {
    return this.prisma.automationRule.findMany({
      where: { organizationId: orgId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
  }

  async create(orgId: string, actorId: string, dto: AutomationRuleDto): Promise<AutomationRule> {
    const { conditions, actions } = await this.validate(orgId, dto.conditions, dto.actions);
    const count: number = await this.prisma.automationRule.count({ where: { organizationId: orgId } });
    if (count >= MAX_RULES) throw new BadRequestException(`A workspace can have at most ${MAX_RULES} rules`);
    const rule = await this.prisma.automationRule.create({
      data: {
        organizationId: orgId,
        name: dto.name.trim(),
        trigger: dto.trigger,
        conditions: conditions as object[],
        actions: actions as object[],
        enabled: dto.enabled ?? true,
        order: dto.order ?? count,
      },
    });
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.automation_created", targetType: "automation_rule", targetId: rule.id, summary: rule.name });
    return rule;
  }

  async update(orgId: string, id: string, actorId: string, dto: UpdateAutomationRuleDto): Promise<AutomationRule> {
    const rule = await this.prisma.automationRule.findFirst({ where: { id, organizationId: orgId } });
    if (!rule) throw new NotFoundException("Rule not found");
    const { conditions, actions } = await this.validate(orgId, dto.conditions ?? rule.conditions, dto.actions ?? rule.actions);
    const updated = await this.prisma.automationRule.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        trigger: dto.trigger,
        conditions: conditions as object[],
        actions: actions as object[],
        enabled: dto.enabled,
        order: dto.order,
      },
    });
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.automation_updated", targetType: "automation_rule", targetId: id, summary: updated.name });
    return updated;
  }

  async remove(orgId: string, id: string, actorId: string): Promise<void> {
    const rule = await this.prisma.automationRule.findFirst({ where: { id, organizationId: orgId } });
    if (!rule) throw new NotFoundException("Rule not found");
    await this.prisma.automationRule.delete({ where: { id } });
    await this.audit.record({ organizationId: orgId, actorId, action: "helpdesk.automation_deleted", targetType: "automation_rule", targetId: id, summary: rule.name });
  }

  /** Shape check against the shared vocabulary, plus: every id an action names belongs to this workspace. */
  private async validate(orgId: string, rawConditions: unknown, rawActions: unknown) {
    const conditions = parseConditions(rawConditions);
    if (!conditions) throw new BadRequestException("Invalid conditions");
    const actions = parseActions(rawActions);
    if (!actions) throw new BadRequestException("Invalid actions");
    for (const action of actions) {
      if (action.type === "assign") {
        const ok = await this.prisma.member.count({ where: { organizationId: orgId, userId: action.value, role: { in: ["owner", "admin"] } } });
        if (!ok) throw new BadRequestException("Assign action must name an owner or admin");
      } else if (action.type === "set_category") {
        const ok = await this.prisma.ticketCategory.count({ where: { id: action.value, organizationId: orgId } });
        if (!ok) throw new BadRequestException("Unknown category in action");
      } else if (action.type === "add_label") {
        const ok = await this.prisma.label.count({ where: { id: action.value, organizationId: orgId } });
        if (!ok) throw new BadRequestException("Unknown label in action");
      }
    }
    return { conditions, actions };
  }
}
