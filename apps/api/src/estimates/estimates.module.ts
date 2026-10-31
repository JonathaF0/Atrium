import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { ContactSyncModule } from "../contact-sync/contact-sync.module";
import { CatalogModule } from "../catalog/catalog.module";
import { AiDraftService } from "./ai-draft.service";
import { EstimateConversionService } from "./estimate-conversion.service";
import { EstimateNotificationsService } from "./estimate-notifications.service";
import { EstimatePdfService } from "./estimate-pdf.service";
import { EstimatesController } from "./estimates.controller";
import { EstimatesPortalService } from "./estimates-portal.service";
import { EstimatesService } from "./estimates.service";
import { EstimatesTask } from "./estimates.task";

@Module({
  imports: [MailModule, NotificationsModule, IntegrationsModule, InvoicesModule, ContactSyncModule, CatalogModule],
  controllers: [EstimatesController],
  providers: [
    EstimatesService,
    EstimatesPortalService,
    EstimateConversionService,
    EstimateNotificationsService,
    EstimatePdfService,
    EstimatesTask,
    AiDraftService,
  ],
  exports: [EstimatesService],
})
export class EstimatesModule {}
