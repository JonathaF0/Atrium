import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MailModule } from "../mail/mail.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { AnnouncementsController } from "./announcements.controller";
import { AnnouncementsService } from "./announcements.service";
import { AnnouncementsPortalService } from "./announcements-portal.service";
import { AnnouncementNotificationsService } from "./announcement-notifications.service";
import { AudienceResolver } from "./audience-resolver.service";
import { AnnouncementsTask } from "./announcements.task";
import { StatusController, StatusPageService } from "./status.controller";

@Module({
  imports: [ScheduleModule.forRoot(), MailModule, NotificationsModule, IntegrationsModule],
  controllers: [AnnouncementsController, StatusController],
  providers: [
    AnnouncementsService,
    AnnouncementsPortalService,
    AnnouncementNotificationsService,
    AudienceResolver,
    AnnouncementsTask,
    StatusPageService,
  ],
  exports: [AudienceResolver, AnnouncementsPortalService],
})
export class AnnouncementsModule {}
