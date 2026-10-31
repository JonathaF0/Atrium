import { Module } from "@nestjs/common";
import { AnnouncementsModule } from "../announcements/announcements.module";
import { PortalHomeController } from "./portal-home.controller";
import { PortalHomeService } from "./portal-home.service";

@Module({
  imports: [AnnouncementsModule],
  controllers: [PortalHomeController],
  providers: [PortalHomeService],
})
export class PortalHomeModule {}
