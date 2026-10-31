import { describe, expect, it, mock } from "bun:test";
import { HelpdeskSettingsService } from "./helpdesk-settings.service";

function build(current: { imapHost: string | null; imapUser: string | null }) {
  const serviceSettings = {
    get: mock(async () => ({ ticketPrefix: "TKT", ...current })),
    update: mock(async () => ({})),
  };
  const prisma = { organization: { findUnique: mock(async () => ({ slug: "ws" })) } };
  const settings = { encrypt: mock((v: string) => `enc:${v}`) };
  const defaults = { ensure: mock(async () => undefined) };
  const audit = { record: mock(async () => undefined) };
  const config = { get: mock(() => undefined) };
  const service = new HelpdeskSettingsService(
    prisma as never,
    serviceSettings as never,
    settings as never,
    defaults as never,
    audit as never,
    config as never,
  );
  // Only the write is under test; skip the response shaping.
  service.get = mock(async () => ({})) as never;
  const written = (): Record<string, unknown> =>
    (serviceSettings.update.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
  return { service, written };
}

describe("updateInbound", () => {
  it("drops the stored IMAP password when the host changes without a new one", async () => {
    const s = build({ imapHost: "imap.example.com", imapUser: "support" });
    await s.service.updateInbound("org", "u1", { imapHost: "attacker.example.net" } as never);
    expect(s.written().imapPass).toBeNull();
  });

  it("drops it when the user changes", async () => {
    const s = build({ imapHost: "imap.example.com", imapUser: "support" });
    await s.service.updateInbound("org", "u1", { imapUser: "someone-else" } as never);
    expect(s.written().imapPass).toBeNull();
  });

  it("keeps it when host and user are unchanged", async () => {
    const s = build({ imapHost: "imap.example.com", imapUser: "support" });
    await s.service.updateInbound("org", "u1", { imapHost: "imap.example.com", imapUser: "support", imapMailbox: "INBOX" } as never);
    expect("imapPass" in s.written()).toBe(false);
  });

  it("stores a new password encrypted", async () => {
    const s = build({ imapHost: null, imapUser: null });
    await s.service.updateInbound("org", "u1", { imapHost: "imap.example.com", imapPass: "secret" } as never);
    expect(s.written().imapPass).toBe("enc:secret");
  });
});
