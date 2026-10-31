import { Global, Module } from "@nestjs/common";
import { FilesModule } from "../files/files.module";
import { SettingsModule } from "../settings/settings.module";
import { AuditService } from "./audit.service";
import { AttachmentStorageService } from "./attachment-storage.service";
import { ClientScopeService } from "./client-scope.service";
import { ServiceSettingsService } from "./service-settings.service";
import { UploadScanner } from "./upload-scanner";

/** Shared building blocks for the helpdesk, knowledge base, estimates and related modules. */
@Global()
@Module({
  imports: [FilesModule, SettingsModule],
  providers: [AuditService, AttachmentStorageService, ClientScopeService, ServiceSettingsService, UploadScanner],
  exports: [AuditService, AttachmentStorageService, ClientScopeService, ServiceSettingsService, UploadScanner],
})
export class ServiceCoreModule {}
