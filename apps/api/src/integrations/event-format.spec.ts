import { describe, expect, it } from "bun:test";
import { INTEGRATION_EVENTS } from "@atrium/shared";
import { eventColor, eventFacts, eventLabel } from "./event-format";
import { formatBody } from "./formatters";
import type { IntegrationPayload, PayloadEvent } from "./integration-payload";

const base: IntegrationPayload = {
  id: "evt_1",
  event: "invoice.overdue",
  createdAt: "2026-10-15T12:00:00.000Z",
  workspace: { id: "org1", name: "Sample Workspace" },
  project: null,
  actor: { id: null, name: "Atrium" },
  title: "Invoice INV-0042 is 7 days overdue",
  detail: "$250.00 was due October 8, 2026. Reminder 2 sent to the client.",
  data: { invoiceNumber: "INV-0042", dueDate: "2026-10-08T12:00:00.000Z", daysOverdue: 7, dunningStage: 2, amountCents: 25000 },
  url: "https://app.example.com/dashboard/invoices/recurring",
};

describe("eventLabel", () => {
  it("labels every shared event id from its group", () => {
    for (const id of INTEGRATION_EVENTS) expect(eventLabel(id)).toMatch(/ · /);
    expect(eventLabel("invoice.overdue")).toBe("Invoices · Overdue reminder sent");
    expect(eventLabel("ticket.sla_breached")).toBe("Helpdesk · Ticket SLA breached");
    expect(eventLabel("estimate.accepted")).toBe("Estimates · Estimate accepted");
    expect(eventLabel("announcement.updated")).toBe("Announcements · Incident update posted");
  });

  it("reads an unknown id as words instead of failing", () => {
    expect(eventLabel("asset.warranty_expiring")).toBe("Asset · Warranty expiring");
    expect(eventLabel("ping")).toBe("Ping");
    expect(eventLabel("test.ping")).toBe("Test message");
  });
});

describe("eventFacts and colours", () => {
  it("picks known fields, formats dates and skips the rest", () => {
    expect(eventFacts(base.data)).toEqual([
      { name: "Invoice", value: "INV-0042" },
      { name: "Due", value: "2026-10-08" },
      { name: "Days overdue", value: "7" },
    ]);
    expect(eventFacts({ reference: "TKT-1001", priority: "high", status: "waiting_on_client", nested: { a: 1 } })).toEqual([
      { name: "Reference", value: "TKT-1001" },
      { name: "Status", value: "waiting on client" },
      { name: "Priority", value: "high" },
    ]);
    expect(eventFacts(undefined)).toEqual([]);
    expect(eventFacts({ dueDate: "not a date", daysOverdue: "x" })).toEqual([]);
  });

  it("colours alerts, payments and overdue reminders", () => {
    expect(eventColor("ticket.sla_breached")).not.toBe(eventColor("ticket.created"));
    expect(eventColor("invoice.paid")).not.toBe(eventColor("invoice.overdue"));
  });
});

describe("formatBody with the new events", () => {
  it("adds facts to Slack and Discord messages for an overdue reminder", () => {
    const slack = JSON.parse(formatBody("slack", base));
    const fields = slack.blocks.find((b: { fields?: unknown[] }) => b.fields)?.fields;
    expect(JSON.stringify(fields)).toContain("INV-0042");
    expect(JSON.stringify(slack.blocks)).toContain("Invoices · Overdue reminder sent");

    const discord = JSON.parse(formatBody("discord", base));
    expect(discord.embeds[0].fields).toContainEqual({ name: "Days overdue", value: "7", inline: true });
    expect(discord.embeds[0].footer.text).toContain("Overdue reminder sent");
  });

  it("formats helpdesk, estimate and announcement events and unknown ids without throwing", () => {
    for (const event of ["ticket.created", "ticket.sla_breached", "estimate.accepted", "announcement.published", "something.new"] as PayloadEvent[]) {
      const payload = { ...base, event, data: { reference: "TKT-1001" } };
      expect(() => formatBody("slack", payload)).not.toThrow();
      const discord = JSON.parse(formatBody("discord", payload));
      expect(discord.embeds[0].fields[0]).toEqual({ name: "Reference", value: "TKT-1001", inline: true });
    }
  });

  it("omits the facts block when there are none", () => {
    const slack = JSON.parse(formatBody("slack", { ...base, data: {} }));
    expect(slack.blocks.some((b: { fields?: unknown[] }) => b.fields)).toBe(false);
    const discord = JSON.parse(formatBody("discord", { ...base, data: {} }));
    expect(discord.embeds[0].fields).toBeUndefined();
  });
});
