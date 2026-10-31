import { createHmac, timingSafeEqual } from "crypto";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), the parameters Better Auth's twoFactor plugin uses. */
export function totpAt(key: Buffer, time: number, period = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / period)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const value =
    ((hmac[offset] & 127) << 24) | ((hmac[offset + 1] & 255) << 16) | ((hmac[offset + 2] & 255) << 8) | (hmac[offset + 3] & 255);
  return String(value % 10 ** digits).padStart(digits, "0");
}

/** Accepts the current code or one step either side, compared in constant time. */
export function verifyTotp(code: string, key: Buffer, now: number = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  let ok = false;
  for (const step of [-1, 0, 1]) {
    const expected = Buffer.from(totpAt(key, now + step * 30_000));
    ok = timingSafeEqual(expected, Buffer.from(code)) || ok;
  }
  return ok;
}
