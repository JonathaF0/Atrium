import { unstable_rethrow } from "next/navigation";
import { serverFetch } from "./server-api";

/** The page a workspace's two-factor requirement sends unenrolled people to. */
export const TWO_FACTOR_SETUP_PATH = "/two-factor-setup";

/**
 * Whether the signed-in user must enrol in two-factor authentication before
 * using the app. Fails open: the API enforces the requirement on every route
 * anyway, so a failed check only skips the friendly redirect.
 */
export async function mustEnrollTwoFactor(): Promise<boolean> {
  try {
    const res: Response = await serverFetch("/api/security/two-factor/status");
    if (!res.ok) return false;
    const body: { mustEnroll?: boolean } = await res.json();
    return body.mustEnroll === true;
  } catch (err) {
    unstable_rethrow(err);
    console.error("Failed to load two-factor status", err);
    return false;
  }
}
