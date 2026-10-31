import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { TaxRatesController } from "./tax-rates.controller";
import { TaxRatesService } from "./tax-rates.service";

@Module({
  controllers: [TaxRatesController, CatalogController],
  providers: [TaxRatesService, CatalogService],
  exports: [TaxRatesService, CatalogService],
})
export class CatalogModule {}
