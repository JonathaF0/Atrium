import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { createReadStream } from "fs";
import { open } from "fs/promises";
import { extname } from "path";
import type { Readable } from "stream";
import { BLOCKED_EXTENSIONS, sanitizeFilename } from "../common";
import type { TempUploadedFile } from "../files/files.service";
import { STORAGE_PROVIDER } from "../files/storage/storage.interface";
import type { StorageProvider } from "../files/storage/storage.interface";
import { SettingsService } from "../settings/settings.service";
import { mimeMatchesContent } from "./content-sniff";
import { UploadScanner } from "./upload-scanner";
import type { ScanStatus } from "./upload-scanner";

export interface StoredAttachment {
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
}

/** Image types that are safe to show inline; everything else downloads as an attachment. */
export const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Stores attachments for tickets, knowledge base articles and client docs.
 * Applies the same rules everywhere: the org's size limit, the extension
 * blocklist, a content check against the declared type, and a malware scan.
 */
@Injectable()
export class AttachmentStorageService {
  constructor(
    private settings: SettingsService,
    private scanner: UploadScanner,
    @Inject(STORAGE_PROVIDER) private storage: StorageProvider,
  ) {}

  async store(file: TempUploadedFile, organizationId: string, folder: string): Promise<StoredAttachment> {
    const maxMb: number = await this.settings.getEffectiveMaxFileSize(organizationId);
    if (file.size > maxMb * 1024 * 1024) {
      throw new PayloadTooLargeException(`File exceeds the maximum allowed size of ${maxMb}MB`);
    }
    if (file.size === 0) throw new BadRequestException("File is empty");
    const ext: string = extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`File type "${ext}" is not allowed`);
    }
    const mimeType: string = (file.mimetype || "application/octet-stream").toLowerCase();
    const head: Buffer = await readHead(file.path);
    if (!mimeMatchesContent(mimeType, head)) {
      throw new BadRequestException("File content does not match its type");
    }

    const scan = await this.scanner.scanFile(file.path);
    if (scan.status === "infected") {
      throw new BadRequestException("File was rejected by the malware scanner");
    }
    if (scan.status === "error" && this.scanner.required) {
      throw new BadRequestException("File could not be scanned; try again later");
    }

    const filename: string = sanitizeFilename(file.originalname);
    const storageKey = `${organizationId}/${folder}/${randomUUID()}-${filename}`;
    await this.storage.upload(storageKey, createReadStream(file.path), file.size, mimeType);
    return { storageKey, filename, mimeType, sizeBytes: file.size, scanStatus: scan.status };
  }

  download(storageKey: string): Promise<{ body: Readable; contentType: string }> {
    return this.storage.download(storageKey);
  }

  async remove(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey).catch(() => undefined);
  }

  /** Stores a generated buffer (rendered PDF, signature image) under the org's folder. */
  async storeBuffer(buffer: Buffer, organizationId: string, folder: string, filename: string, mimeType: string): Promise<string> {
    const { Readable } = await import("stream");
    const storageKey = `${organizationId}/${folder}/${randomUUID()}-${sanitizeFilename(filename)}`;
    await this.storage.upload(storageKey, Readable.from(buffer), buffer.length, mimeType);
    return storageKey;
  }
}

async function readHead(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buf, 0, 512, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
