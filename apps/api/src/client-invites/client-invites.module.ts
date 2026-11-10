import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { BillingModule } from "../billing/billing.module";
import { ContactSyncModule } from "../contact-sync/contact-sync.module";
import { ClientInvitesController } from "./client-invites.controller";
import { ClientInvitesService } from "./client-invites.service";

@Module({
  imports: [MailModule, BillingModule, ContactSyncModule],
  controllers: [ClientInvitesController],
  providers: [ClientInvitesService],
})
export class ClientInvitesModule {}
