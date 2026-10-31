import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

/**
 * AES-256-GCM for small secrets kept in the database (SSO client secrets).
 * The key is derived from BETTER_AUTH_SECRET with its own HKDF label, so it is
 * never the signing key itself and differs from the settings key.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "atrium-sso-secrets", "aes-256-gcm-key", 32));
  }

  static isSealed(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
  }

  /** The plaintext, or null when the value was not sealed with this key. */
  open(sealed: string): string | null {
    if (!SecretBox.isSealed(sealed)) return null;
    try {
      const [iv, tag, data] = sealed.slice(PREFIX.length).split(".");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
