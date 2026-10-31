import type { PrismaClient } from "@atrium/database";
import { SecretBox } from "./secret-box";

/** Replaces a sealed clientSecret inside a stored oidcConfig JSON string with its plaintext. */
export function openOidcConfig(raw: string | null | undefined, box: SecretBox): string | null | undefined {
  if (!raw) return raw;
  try {
    const config = JSON.parse(raw) as { clientSecret?: unknown };
    if (!SecretBox.isSealed(config.clientSecret)) return raw;
    return JSON.stringify({ ...config, clientSecret: box.open(config.clientSecret) ?? "" });
  } catch {
    return raw;
  }
}

function openRow(row: unknown, box: SecretBox): unknown {
  if (!row || typeof row !== "object") return row;
  const r = row as { oidcConfig?: string | null };
  return "oidcConfig" in r ? { ...r, oidcConfig: openOidcConfig(r.oidcConfig, box) } : row;
}

/**
 * The Prisma client Better Auth gets when SSO is on. The sso plugin reads
 * `ssoProvider.oidcConfig` and uses its clientSecret directly, so the secret is
 * stored sealed and unsealed here, on reads only; nothing else changes.
 */
export function withSsoSecrets<T extends PrismaClient>(prisma: T, box: SecretBox): T {
  return prisma.$extends({
    query: {
      ssoProvider: {
        async $allOperations({ operation, args, query }) {
          const result: unknown = await query(args);
          if (!operation.startsWith("find")) return result;
          return Array.isArray(result) ? result.map((row) => openRow(row, box)) : openRow(result, box);
        },
      },
    },
  }) as unknown as T;
}
