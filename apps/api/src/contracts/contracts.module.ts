import { Module } from "@nestjs/common";
import { AssetsModule } from "../assets/assets.module";
import { ContractsController } from "./contracts.controller";
import { ContractsService } from "./contracts.service";
import { ContractRenewalTask } from "./contract-renewal.task";

/** Exports ContractsService: the helpdesk calls coverageFor() to pick SLA and billing defaults. */
@Module({
  imports: [AssetsModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractRenewalTask],
  exports: [ContractsService],
})
export class ContractsModule {}
