import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentOrg, Roles, RolesGuard } from "../common";
import { CreateTaxRateDto, UpdateTaxRateDto } from "./tax-rates.dto";
import { TaxRatesService } from "./tax-rates.service";

@Controller("tax-rates")
@UseGuards(AuthGuard, RolesGuard)
export class TaxRatesController {
  constructor(private taxRates: TaxRatesService) {}

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query("archived") archived?: string) {
    return this.taxRates.list(orgId, archived === "true");
  }

  @Post()
  @Roles("owner", "admin")
  create(@CurrentOrg("id") orgId: string, @Body() dto: CreateTaxRateDto) {
    return this.taxRates.create(orgId, dto);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(@CurrentOrg("id") orgId: string, @Param("id") id: string, @Body() dto: UpdateTaxRateDto) {
    return this.taxRates.update(orgId, id, dto);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  async remove(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    await this.taxRates.remove(orgId, id);
    return { ok: true };
  }
}
