import { Module } from "@nestjs/common";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { KbController } from "./kb.controller";
import { KbPortalController } from "./kb-portal.controller";
import { KbPublicController } from "./kb-public.controller";
import { KbAccessService } from "./kb-access.service";
import { KbArticlesService } from "./kb-articles.service";
import { KbCollectionsService } from "./kb-collections.service";
import { KbReaderService } from "./kb-reader.service";
import { KbReviewTask } from "./kb-review.task";

@Module({
  imports: [MailModule, NotificationsModule],
  controllers: [KbController, KbPortalController, KbPublicController],
  providers: [KbAccessService, KbArticlesService, KbCollectionsService, KbReaderService, KbReviewTask],
  exports: [KbAccessService, KbReaderService, KbArticlesService],
})
export class KbModule {}
