import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { PaymentsModule } from "../payments/payments.module";
import { BillingModule } from "../billing/billing.module";
import { RecurringInvoicesController } from "./recurring-invoices.controller";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { RecurringGeneratorService } from "./recurring-generator.service";
import { RecurringNotificationsService } from "./recurring-notifications.service";
import { RecurringStripeService } from "./recurring-stripe.service";
import { RecurringInvoicesTask } from "./recurring-invoices.task";
import { DunningTask } from "./dunning.task";

@Module({
  imports: [ScheduleModule.forRoot(), MailModule, NotificationsModule, IntegrationsModule, PaymentsModule, BillingModule],
  controllers: [RecurringInvoicesController],
  providers: [
    RecurringInvoicesService,
    RecurringGeneratorService,
    RecurringNotificationsService,
    RecurringStripeService,
    RecurringInvoicesTask,
    DunningTask,
  ],
  exports: [RecurringInvoicesService, RecurringGeneratorService],
})
export class RecurringInvoicesModule {}
