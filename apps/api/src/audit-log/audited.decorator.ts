import { SetMetadata } from "@nestjs/common";
import type { Request } from "express";

export const AUDITED_KEY = "atrium:audited";

type FromRequest<T> = (req: Request, result: unknown) => T;

export interface AuditSpec {
  /** Dotted action, or a function returning one; returning null skips the entry. */
  action: string | FromRequest<string | null>;
  targetType: string;
  /** Defaults to the `:id` route parameter. */
  targetId?: FromRequest<string | null | undefined>;
  summary?: string | FromRequest<string>;
  metadata?: FromRequest<Record<string, unknown> | undefined>;
}

/**
 * Writes an audit-log entry after the handler succeeds (see AuditInterceptor).
 * For sensitive routes whose service has no actor to record, so the service
 * itself stays unchanged.
 */
export const Audited = (spec: AuditSpec): MethodDecorator & ClassDecorator => SetMetadata(AUDITED_KEY, spec);
