import { describe, expect, it, mock } from "bun:test";
import { ticketTools } from "./tickets.tools";
import { runTool } from "../tool-kit";
import type { Actor } from "../../common";

const admin = {
  user: { id: "u1", name: "Alex Agent", email: "alex@example.com" },
  organization: { id: "org1" },
  member: { role: "admin" },
} as unknown as Actor;
const actor = { userId: "u1", name: "Alex Agent", email: "alex@example.com" };

function build() {
  const tickets = {
    list: mock(() => Promise.resolve({ data: [], meta: {} })),
    findOne: mock(() => Promise.resolve({ id: "t1" })),
    reply: mock(() => Promise.resolve({ id: "m1" })),
    update: mock(() => Promise.resolve({ id: "t1" })),
  };
  const tools = ticketTools({ tickets: tickets as never });
  return { tickets, get: (n: string) => tools.find((t) => t.name === n)! };
}

describe("ticket tools", () => {
  it("list_tickets defaults to the open view in the actor's org", async () => {
    const { tickets, get } = build();
    const input = get("list_tickets").inputSchema.parse({});
    await runTool(get("list_tickets"), input, admin);
    expect(tickets.list).toHaveBeenCalledWith("org1", "u1", { view: "open", page: 1, limit: 20 });
  });

  it("list_tickets rejects unknown views and statuses", () => {
    const schema = build().get("list_tickets").inputSchema;
    expect(schema.safeParse({ view: "everything" }).success).toBe(false);
    expect(schema.safeParse({ status: "pending" }).success).toBe(false);
  });

  it("get_ticket reads within the actor's org", async () => {
    const { tickets, get } = build();
    await runTool(get("get_ticket"), { ticketId: "t1" }, admin);
    expect(tickets.findOne).toHaveBeenCalledWith("t1", "org1");
  });

  it("add_ticket_note posts an internal note", async () => {
    const { tickets, get } = build();
    await runTool(get("add_ticket_note"), get("add_ticket_note").inputSchema.parse({ ticketId: "t1", body: " Checked logs " }), admin);
    expect(tickets.reply).toHaveBeenCalledWith("t1", "org1", actor, { body: "Checked logs", visibility: "internal" });
  });

  it("reply_to_ticket posts a public reply and passes the status", async () => {
    const { tickets, get } = build();
    await runTool(get("reply_to_ticket"), { ticketId: "t1", body: "Fixed", status: "resolved" }, admin);
    expect(tickets.reply).toHaveBeenCalledWith("t1", "org1", actor, { body: "Fixed", visibility: "public", status: "resolved" });
  });

  it("update_ticket separates the id and allows unassigning", async () => {
    const { tickets, get } = build();
    const input = get("update_ticket").inputSchema.parse({ ticketId: "t1", assigneeId: null, priority: "high" });
    await runTool(get("update_ticket"), input, admin);
    expect(tickets.update).toHaveBeenCalledWith("t1", "org1", actor, { assigneeId: null, priority: "high" });
  });

  it("rejects empty bodies", () => {
    expect(build().get("reply_to_ticket").inputSchema.safeParse({ ticketId: "t1", body: "  " }).success).toBe(false);
  });
});
