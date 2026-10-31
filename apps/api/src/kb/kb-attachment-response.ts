import type { Response } from "express";
import { contentDisposition } from "../common";
import { INLINE_IMAGE_MIMES } from "../service-core";
import type { AttachmentStorageService } from "../service-core";

/**
 * Streams a stored attachment. Only known-safe image types render inline (so
 * they can be embedded in an article); everything else downloads.
 */
export async function sendKbAttachment(
  res: Response,
  attachment: { storageKey: string; filename: string; mimeType: string },
  storage: AttachmentStorageService,
  cacheControl: string = "private, max-age=300",
): Promise<void> {
  const { body } = await storage.download(attachment.storageKey);
  const inline: boolean = INLINE_IMAGE_MIMES.has(attachment.mimeType);
  res.setHeader("Content-Type", inline ? attachment.mimeType : "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(attachment.filename, inline ? "inline" : "attachment"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", cacheControl);
  body.pipe(res);
}
