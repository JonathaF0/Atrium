import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { MailModule } from "../mail/mail.module";
import { AssetsController } from "./assets.controller";
import { AssetsService } from "./assets.service";
import { AssetSyncService } from "./asset-sync.service";
import { AssetRenewalTask } from "./asset-renewal.task";
import { RenewalNotifier } from "./renewal-notifier";

@Module({
  imports: [NotificationsModule, MailModule],
  controllers: [AssetsController],
  providers: [AssetsService, AssetSyncService, AssetRenewalTask, RenewalNotifier],
  exports: [AssetsService, RenewalNotifier],
})
export class AssetsModule {}
