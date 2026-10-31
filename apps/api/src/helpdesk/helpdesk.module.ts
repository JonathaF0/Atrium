import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { SettingsModule } from "../settings/settings.module";
import { TimeEntriesModule } from "../time-entries/time-entries.module";
import { ContractsModule } from "../contracts/contracts.module";
import { TicketsPortalController } from "./tickets-portal.controller";
import { TicketsController } from "./tickets.controller";
import { HelpdeskSettingsController } from "./helpdesk-settings.controller";
import { InboundController } from "./inbound/inbound.controller";
import { TicketsService } from "./tickets.service";
import { TicketsOpsService } from "./tickets-ops.service";
import { HelpdeskDefaultsService } from "./helpdesk-defaults.service";
import { HelpdeskNotificationsService } from "./helpdesk-notifications.service";
import { HelpdeskSettingsService } from "./helpdesk-settings.service";
import { CannedResponsesService } from "./canned-responses.service";
import { AutomationService } from "./automation.service";
import { SlaService } from "./sla.service";
import { InboundEmailService } from "./inbound/inbound.service";
import { AutoCloseTask, ImapPollTask, SlaTask } from "./helpdesk.tasks";

@Module({
  imports: [ScheduleModule.forRoot(), MailModule, NotificationsModule, IntegrationsModule, SettingsModule, TimeEntriesModule, ContractsModule],
  // The portal controller must come first: `/tickets/mine` would otherwise match `/tickets/:id`.
  controllers: [TicketsPortalController, TicketsController, HelpdeskSettingsController, InboundController],
  providers: [
    TicketsService,
    TicketsOpsService,
    HelpdeskDefaultsService,
    HelpdeskNotificationsService,
    HelpdeskSettingsService,
    CannedResponsesService,
    AutomationService,
    SlaService,
    InboundEmailService,
    SlaTask,
    AutoCloseTask,
    ImapPollTask,
  ],
  exports: [TicketsService, HelpdeskDefaultsService],
})
export class HelpdeskModule {}
