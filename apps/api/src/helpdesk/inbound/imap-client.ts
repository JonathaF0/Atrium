import { ImapFlow } from "imapflow";

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_MESSAGES_PER_POLL = 25;

function client(cfg: ImapConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
  });
}

export async function testImapConnection(cfg: ImapConfig): Promise<{ ok: boolean; error?: string; messages?: number }> {
  const imap: ImapFlow = client(cfg);
  imap.on("error", () => undefined);
  try {
    await imap.connect();
    const status = await imap.status(cfg.mailbox, { messages: true });
    return { ok: true, messages: status ? status.messages : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "Connection failed" };
  } finally {
    await imap.logout().catch(() => undefined);
  }
}

/**
 * Fetches messages with a UID above `lastUid`, oldest first, at most a batch
 * per call. With no `lastUid` (first poll, or a changed mailbox) it fetches
 * nothing and returns the current high-water mark, so old mail is not imported.
 */
export async function fetchNewMessages(
  cfg: ImapConfig,
  lastUid: number | null,
  handle: (uid: number, source: Buffer) => Promise<void>,
): Promise<number> {
  const imap: ImapFlow = client(cfg);
  imap.on("error", () => undefined);
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(cfg.mailbox);
    try {
      const mailbox = imap.mailbox;
      const uidNext: number = mailbox && typeof mailbox === "object" ? Number(mailbox.uidNext ?? 1) : 1;
      if (lastUid === null) return Math.max(uidNext - 1, 0);
      let highest: number = lastUid;
      const batch: { uid: number; source: Buffer }[] = [];
      for await (const msg of imap.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
        if (msg.uid <= lastUid || !msg.source) continue;
        batch.push({ uid: msg.uid, source: msg.source });
        if (batch.length >= MAX_MESSAGES_PER_POLL) break;
      }
      batch.sort((a, b) => a.uid - b.uid);
      for (const m of batch) {
        await handle(m.uid, m.source);
        highest = Math.max(highest, m.uid);
      }
      return highest;
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => undefined);
  }
}
