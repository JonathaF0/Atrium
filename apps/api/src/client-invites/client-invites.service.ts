import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { ConfigService } from "@nestjs/config";
import { InvitationEmail } from "@atrium/email";
import type { Company, Contact } from "@atrium/database";
import { PrismaService } from "../prisma/prisma.service";
import { MailService } from "../mail/mail.service";
import { EmailRenderer } from "../mail/email-renderer";
import { BillingService } from "../billing/billing.service";
import { ContactSyncService, normalizeEmail } from "../contact-sync/contact-sync.service";
import {
  INVITATION_EXPIRES_IN_SECONDS,
  PORTAL_INVITATION_ROLE,
  formatInvitationExpiry,
  logsInviteLinks,
} from "../clients/invitations";
import { isPrismaUniqueViolation } from "../common/helpers/prisma-errors";
import { AuditService } from "../service-core";
import { auditContext } from "../service-core";
import type { AuditRequestContext } from "../service-core";
import type { InviteClientDto } from "./client-invites.dto";

export type InviteStatus = "invited" | "already_invited" | "already_client";

export interface InviteResult {
  status: InviteStatus;
  contactId: string;
  companyId: string | null;
  invitationId: string | null;
  /** False when no email provider is configured or the provider refused the message. */
  emailSent: boolean;
}

export interface InviteActor {
  userId: string;
  name: string;
  email: string;
  apiKeyId?: string;
}

/**
 * Gives a person portal access from an outside system: creates or fills in
 * their contact and company, then sends the same invitation email as
 * "Invite to portal" on the contact page. Safe to call repeatedly for the same
 * person: a pending invitation or an existing login is reported, not repeated.
 */
@Injectable()
export class ClientInvitesService {
  private readonly logger = new Logger(ClientInvitesService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private renderer: EmailRenderer,
    private billing: BillingService,
    private contactSync: ContactSyncService,
    private audit: AuditService,
    private config: ConfigService,
  ) {}

  async invite(orgId: string, actor: InviteActor, dto: InviteClientDto, req?: AuditRequestContext): Promise<InviteResult> {
    const email: string = normalizeEmail(dto.email);

    const member = await this.prisma.member.findFirst({
      where: { organizationId: orgId, user: { email } },
      select: { role: true },
    });
    if (member && member.role !== "member") {
      throw new ConflictException("That email belongs to a member of your team");
    }

    const company: Company | null = dto.company?.trim() ? await this.findOrCreateCompany(orgId, dto.company.trim()) : null;
    const contact: Contact = await this.upsertContact(orgId, email, dto, company?.id ?? null);

    if (member) {
      return { status: "already_client", contactId: contact.id, companyId: contact.companyId, invitationId: null, emailSent: false };
    }

    const now = new Date();
    if (!dto.resend) {
      const pending = await this.prisma.invitation.findFirst({
        where: { organizationId: orgId, email, status: "pending", expiresAt: { gt: now }, AND: [PORTAL_INVITATION_ROLE] },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (pending) {
        return { status: "already_invited", contactId: contact.id, companyId: contact.companyId, invitationId: pending.id, emailSent: false };
      }
    }

    await this.billing.assertPlanLimit(orgId, "clients");
    const invitation = await this.prisma.invitation.create({
      data: {
        // Same shape as Better Auth's own ids; the accept page looks invitations up by id.
        id: randomBytes(24).toString("base64url"),
        organizationId: orgId,
        email,
        role: "member",
        status: "pending",
        expiresAt: new Date(now.getTime() + INVITATION_EXPIRES_IN_SECONDS * 1000),
        inviterId: actor.userId,
      },
      include: { organization: { select: { name: true } } },
    });
    await this.contactSync.recordInvited(orgId, email, "member");

    const emailSent: boolean = await this.sendInvitationEmail(
      invitation.id,
      email,
      invitation.organization.name,
      orgId,
      actor.name,
      invitation.expiresAt,
    );

    await this.audit.record({
      organizationId: orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      action: "member.invited",
      targetType: "contact",
      targetId: contact.id,
      summary: `Invited ${email} to the client portal`,
      metadata: { via: actor.apiKeyId ? "api_key" : "session", externalId: dto.externalId ?? null, emailSent },
      ...auditContext(req),
    });

    return { status: "invited", contactId: contact.id, companyId: contact.companyId, invitationId: invitation.id, emailSent };
  }

  private async findOrCreateCompany(orgId: string, name: string): Promise<Company> {
    const existing = await this.prisma.company.findFirst({
      where: { organizationId: orgId, name: { equals: name, mode: "insensitive" } },
    });
    if (existing) return existing;
    try {
      return await this.prisma.company.create({ data: { organizationId: orgId, name } });
    } catch (err) {
      if (!isPrismaUniqueViolation(err)) throw err;
      const winner = await this.prisma.company.findFirst({ where: { organizationId: orgId, name } });
      if (!winner) throw err;
      return winner;
    }
  }

  /** Creates the contact, or fills in fields an existing one is missing; never overwrites what staff entered. */
  private async upsertContact(orgId: string, email: string, dto: InviteClientDto, companyId: string | null): Promise<Contact> {
    const firstName: string | null = dto.firstName?.trim() || null;
    const lastName: string | null = dto.lastName?.trim() || null;
    const name: string = [firstName, lastName].filter(Boolean).join(" ") || email;
    const phone: string | null = dto.phone?.trim() || null;
    const jobTitle: string | null = dto.jobTitle?.trim() || null;

    const existing: Contact = await this.contactSync.ensureForInvitee(orgId, email);
    const unnamed: boolean = existing.name === email && !existing.firstName && !existing.lastName;
    return this.prisma.contact.update({
      where: { id: existing.id },
      data: {
        ...(unnamed && (firstName || lastName) ? { name, firstName, lastName } : {}),
        ...(!existing.phone && phone ? { phone, phones: [{ label: "Work", number: phone }] } : {}),
        ...(!existing.jobTitle && jobTitle ? { jobTitle } : {}),
        ...(!existing.companyId && companyId ? { companyId } : {}),
        // A converted lead is a client now.
        ...(existing.status === "lead" ? { status: "client" } : {}),
      },
    });
  }

  private async sendInvitationEmail(
    invitationId: string,
    email: string,
    organizationName: string,
    orgId: string,
    inviterName: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const webUrl: string = this.config.get<string>("WEB_URL", "http://localhost:3000");
    const inviteUrl = `${webUrl}/accept-invite?id=${invitationId}`;
    let sent = false;
    try {
      const html: string = await this.renderer.render(
        InvitationEmail({ inviteUrl, organizationName, inviterName, expiresOn: formatInvitationExpiry(expiresAt) }),
      );
      sent = (await this.mail.send(email, `You've been invited to ${organizationName}`, html, orgId)).sent;
    } catch (err) {
      this.logger.error(`Invitation email to ${email} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (logsInviteLinks(process.env.NODE_ENV)) {
      this.logger.log(`Invitation for ${email} ${sent ? "emailed" : "NOT emailed"}; accept at ${inviteUrl}`);
    }
    return sent;
  }
}
