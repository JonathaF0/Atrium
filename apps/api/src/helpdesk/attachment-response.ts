import type { Response } from "express";
import type { Readable } from "stream";
import { contentDisposition } from "../common";
import { INLINE_IMAGE_MIMES } from "../service-core";

/** Streams an attachment: inline only for safe image types, never sniffed by the browser. */
export function sendAttachment(res: Response, file: { body: Readable; filename: string; mimeType: string }): void {
  const inline: boolean = INLINE_IMAGE_MIMES.has(file.mimeType);
  res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", contentDisposition(file.filename, inline ? "inline" : "attachment"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  file.body.pipe(res);
}
