import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentOrg, Roles, RolesGuard } from "../common";
import {
  CatalogBundleDto,
  CatalogItemDto,
  CatalogListQueryDto,
  UpdateCatalogBundleDto,
  UpdateCatalogItemDto,
} from "./catalog.dto";
import { CatalogService } from "./catalog.service";

// Rates and costs are internal pricing data: staff only.
@Controller("catalog")
@UseGuards(AuthGuard, RolesGuard)
export class CatalogController {
  constructor(private catalog: CatalogService) {}

  @Get("items")
  @Roles("owner", "admin")
  listItems(@CurrentOrg("id") orgId: string, @Query() q: CatalogListQueryDto) {
    return this.catalog.listItems(orgId, q);
  }

  @Get("categories")
  @Roles("owner", "admin")
  categories(@CurrentOrg("id") orgId: string) {
    return this.catalog.categories(orgId);
  }

  @Get("items/:id")
  @Roles("owner", "admin")
  getItem(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.catalog.getItem(orgId, id);
  }

  @Post("items")
  @Roles("owner", "admin")
  createItem(@CurrentOrg("id") orgId: string, @Body() dto: CatalogItemDto) {
    return this.catalog.createItem(orgId, dto);
  }

  @Put("items/:id")
  @Roles("owner", "admin")
  updateItem(@CurrentOrg("id") orgId: string, @Param("id") id: string, @Body() dto: UpdateCatalogItemDto) {
    return this.catalog.updateItem(orgId, id, dto);
  }

  @Delete("items/:id")
  @Roles("owner", "admin")
  async removeItem(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    await this.catalog.removeItem(orgId, id);
    return { ok: true };
  }

  @Get("bundles")
  @Roles("owner", "admin")
  listBundles(@CurrentOrg("id") orgId: string, @Query() q: CatalogListQueryDto) {
    return this.catalog.listBundles(orgId, q);
  }

  @Get("bundles/:id")
  @Roles("owner", "admin")
  getBundle(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    return this.catalog.getBundle(orgId, id);
  }

  @Post("bundles")
  @Roles("owner", "admin")
  createBundle(@CurrentOrg("id") orgId: string, @Body() dto: CatalogBundleDto) {
    return this.catalog.createBundle(orgId, dto);
  }

  @Put("bundles/:id")
  @Roles("owner", "admin")
  updateBundle(@CurrentOrg("id") orgId: string, @Param("id") id: string, @Body() dto: UpdateCatalogBundleDto) {
    return this.catalog.updateBundle(orgId, id, dto);
  }

  @Delete("bundles/:id")
  @Roles("owner", "admin")
  async removeBundle(@CurrentOrg("id") orgId: string, @Param("id") id: string) {
    await this.catalog.removeBundle(orgId, id);
    return { ok: true };
  }
}
