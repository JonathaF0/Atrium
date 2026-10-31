import type { CannedContext } from "./canned";

/** Shared test context for canned response specs. */
export const canned: CannedContext = {
  ticket: { number: 1042, subject: "Printer offline", status: "waiting_client" },
  prefix: "TKT",
  requesterName: "Sam Sample",
  companyName: "Sample Co",
  agentName: "Alex Agent",
  workspaceName: "Sample Workspace",
};
