import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { Observable, mergeMap } from "rxjs";
import { AuditService, auditContext } from "../service-core";
import { AUDITED_KEY, type AuditSpec } from "./audited.decorator";

type AuditedRequest = Request & {
  user?: { id: string; email?: string };
  organization?: { id: string };
  previewMode?: boolean;
};

/** Resolves an AuditSpec against a finished request; null when nothing should be written. */
export function resolveAuditEntry(spec: AuditSpec, req: AuditedRequest, result: unknown) {
  const organizationId = req.organization?.id;
  if (!organizationId) return null;
  const action = typeof spec.action === "function" ? spec.action(req, result) : spec.action;
  if (!action) return null;
  const targetId = spec.targetId ? spec.targetId(req, result) : (req.params?.id as string | undefined);
  const summary = typeof spec.summary === "function" ? spec.summary(req, result) : spec.summary;
  return {
    organizationId,
    actorId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? null,
    action,
    targetType: spec.targetType,
    targetId: targetId ?? null,
    summary,
    metadata: spec.metadata?.(req, result) as never,
    ...auditContext(req),
  };
}

/** Global: records routes marked with @Audited once they succeed. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    private audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<AuditSpec | undefined>(AUDITED_KEY, context.getHandler());
    if (!spec || context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<AuditedRequest>();
    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const entry = resolveAuditEntry(spec, req, result);
        if (entry) await this.audit.record(entry);
        return result;
      }),
    );
  }
}
