/**
 * Detects a file's real type from its first bytes so a renamed executable or
 * HTML page can't be uploaded as an image. Returns null for types without a
 * reliable signature (plain text, CSV), which callers accept only when the
 * declared type is itself a text type.
 */
export function sniffMime(head: Buffer): string | null {
  const startsWith = (sig: number[], offset = 0): boolean =>
    head.length >= offset + sig.length && sig.every((b, i) => head[offset + i] === b);

  if (startsWith([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (startsWith([0xd0, 0xcf, 0x11, 0xe0])) return "application/x-ole-storage";
  if (startsWith([0x4d, 0x5a])) return "application/x-msdownload";
  if (startsWith([0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf";
  const text: string = head.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (text.startsWith("<!doctype html") || text.startsWith("<html") || text.startsWith("<script")) return "text/html";
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "image/svg+xml";
  return null;
}

const ZIP_CONTAINERS = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

const OLE_CONTAINERS = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-outlook",
]);

const TEXT_TYPES = new Set(["text/plain", "text/csv", "application/json", "message/rfc822", "text/x-log"]);

/** Content that is never accepted, whatever the declared type: it runs or renders as active content. */
const ACTIVE_CONTENT = new Set(["application/x-msdownload", "application/x-elf", "text/html", "image/svg+xml"]);

/** True when the sniffed signature is consistent with the declared MIME type. */
export function mimeMatchesContent(declared: string, head: Buffer): boolean {
  const sniffed: string | null = sniffMime(head);
  if (sniffed && ACTIVE_CONTENT.has(sniffed)) return false;
  const type: string = declared.toLowerCase().split(";")[0].trim();
  if (sniffed === null) return TEXT_TYPES.has(type) || type === "application/octet-stream";
  if (sniffed === type) return true;
  if (sniffed === "application/zip") return ZIP_CONTAINERS.has(type);
  if (sniffed === "application/x-ole-storage") return OLE_CONTAINERS.has(type);
  return type === "application/octet-stream";
}
