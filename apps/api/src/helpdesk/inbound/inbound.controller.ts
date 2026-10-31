import { Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../../common";
import { InboundEmailService } from "./inbound.service";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./email-parsing";

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Inbound email webhook. Public (no session, so the CSRF guard skips it, like
 * the Stripe webhook); every request must carry an HMAC-SHA256 signature over
 * the raw body made with the workspace's inbound secret.
 */
@Controller("helpdesk/inbound")
@Public()
export class InboundController {
  constructor(private inbound: InboundEmailService) {}

  @Post(":orgSlug")
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async receive(@Param("orgSlug") orgSlug: string, @Req() req: RawBodyRequest<Request>) {
    const result = await this.inbound.receiveWebhook(
      orgSlug.slice(0, 100),
      req.rawBody,
      header(req, SIGNATURE_HEADER),
      header(req, TIMESTAMP_HEADER),
    );
    return { status: result.status, ticketId: result.ticketId };
  }
}
