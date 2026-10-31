import { Module } from "@nestjs/common";
import { ClientDocsController } from "./client-docs.controller";
import { ClientDocsService } from "./client-docs.service";

@Module({
  controllers: [ClientDocsController],
  providers: [ClientDocsService],
})
export class ClientDocsModule {}
