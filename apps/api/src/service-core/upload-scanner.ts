import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream } from "fs";
import { Socket } from "net";

export type ScanStatus = "clean" | "infected" | "skipped" | "error";

export interface ScanResult {
  status: ScanStatus;
  signature?: string;
}

const CHUNK_SIZE = 64 * 1024;

/**
 * Scans uploads with ClamAV (clamd INSTREAM over TCP) when CLAMAV_HOST is set.
 * Without it, uploads are "skipped" and rely on the extension blocklist, size
 * limit and content sniffing. With CLAMAV_REQUIRED=true, a scanner error
 * rejects the upload instead of letting it through.
 */
@Injectable()
export class UploadScanner {
  private readonly logger = new Logger(UploadScanner.name);
  private readonly host: string | undefined;
  private readonly port: number;
  private readonly timeoutMs: number;
  readonly required: boolean;

  constructor(config: ConfigService) {
    this.host = config.get<string>("CLAMAV_HOST") || undefined;
    this.port = parseInt(config.get<string>("CLAMAV_PORT", "3310"), 10);
    this.timeoutMs = parseInt(config.get<string>("CLAMAV_TIMEOUT_MS", "30000"), 10);
    this.required = config.get<string>("CLAMAV_REQUIRED", "false") === "true";
  }

  get enabled(): boolean {
    return !!this.host;
  }

  async scanFile(path: string): Promise<ScanResult> {
    if (!this.host) return { status: "skipped" };
    try {
      const reply: string = await this.instream(path);
      return parseClamdReply(reply);
    } catch (err) {
      this.logger.warn(`ClamAV scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return { status: "error" };
    }
  }

  private instream(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let reply = "";
      const fail = (err: Error): void => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(this.timeoutMs, () => fail(new Error("timed out")));
      socket.on("error", fail);
      socket.on("data", (d: Buffer) => (reply += d.toString("utf8")));
      socket.on("end", () => resolve(reply));
      socket.connect(this.port, this.host as string, () => {
        socket.write("zINSTREAM\0");
        const stream = createReadStream(path, { highWaterMark: CHUNK_SIZE });
        stream.on("data", (chunk: Buffer | string) => {
          const buf: Buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          const size = Buffer.alloc(4);
          size.writeUInt32BE(buf.length, 0);
          socket.write(size);
          socket.write(buf);
        });
        stream.on("error", fail);
        stream.on("end", () => socket.write(Buffer.alloc(4)));
      });
    });
  }
}

/** Parses clamd's "stream: OK" / "stream: Eicar-Signature FOUND" reply. */
export function parseClamdReply(reply: string): ScanResult {
  const text: string = reply.replace(/\0/g, "").trim();
  if (/:\s*OK$/.test(text)) return { status: "clean" };
  const found: RegExpMatchArray | null = text.match(/:\s*(.+)\s+FOUND$/);
  if (found) return { status: "infected", signature: found[1] };
  return { status: "error" };
}
