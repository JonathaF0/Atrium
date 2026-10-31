import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentOrg, CurrentUser, Roles, RolesGuard } from "../common";
import type { AuthenticatedRequest } from "../common/types/authenticated-request";
import { auditContext } from "../service-core";
import { ContractsService } from "./contracts.service";
import type { ContractActor } from "./contracts.service";
import { CreateContractDto, ListContractsQueryDto, UpdateContractDto, UsageQueryDto } from "./contracts.dto";

function actorOf(req: AuthenticatedRequest): ContractActor {
  return { id: req.user?.id ?? null, email: req.user?.email ?? null, ...auditContext(req) };
}

@Controller("contracts")
@UseGuards(AuthGuard, RolesGuard)
export class ContractsController {
  constructor(private contracts: ContractsService) {}

  // Static routes must be declared before ":id".

  /** Portal: the company's contracts in force, for company admins (empty for everyone else). */
  @Get("mine")
  mine(@CurrentUser("id") userId: string, @CurrentOrg("id") orgId: string) {
    return this.contracts.mine(userId, orgId);
  }

  @Get("covered-hours")
  @Roles("owner", "admin")
  coveredHours(@CurrentOrg("id") orgId: string) {
    return this.contracts.coveredHours(orgId);
  }

  /** SLA policies a contract can point at (id and name only). */
  @Get("sla-policies")
  @Roles("owner", "admin")
  slaPolicies(@CurrentOrg("id") orgId: string) {
    return this.contracts.slaPolicies(orgId);
  }

  @Get("coverage/:companyId")
  @Roles("owner", "admin")
  coverage(@Param("companyId") companyId: string, @CurrentOrg("id") orgId: string) {
    return this.contracts.coverageFor(orgId, companyId);
  }

  @Get()
  @Roles("owner", "admin")
  list(@CurrentOrg("id") orgId: string, @Query() query: ListContractsQueryDto) {
    return this.contracts.list(orgId, query);
  }

  @Post()
  @Roles("owner", "admin")
  create(@Body() dto: CreateContractDto, @CurrentOrg("id") orgId: string, @Req() req: AuthenticatedRequest) {
    return this.contracts.create(orgId, dto, actorOf(req));
  }

  @Get(":id")
  @Roles("owner", "admin")
  get(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.contracts.get(orgId, id);
  }

  @Put(":id")
  @Roles("owner", "admin")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateContractDto,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.contracts.update(orgId, id, dto, actorOf(req));
  }

  @Delete(":id")
  @Roles("owner", "admin")
  async remove(@Param("id") id: string, @CurrentOrg("id") orgId: string, @Req() req: AuthenticatedRequest) {
    await this.contracts.remove(orgId, id, actorOf(req));
    return { deleted: true };
  }

  @Get(":id/usage")
  @Roles("owner", "admin")
  usage(@Param("id") id: string, @Query() query: UsageQueryDto, @CurrentOrg("id") orgId: string) {
    return this.contracts.usage(orgId, id, query.at ? new Date(query.at) : new Date());
  }

  @Get(":id/time-entries")
  @Roles("owner", "admin")
  timeEntries(@Param("id") id: string, @Query() query: UsageQueryDto, @CurrentOrg("id") orgId: string) {
    return this.contracts.timeEntries(orgId, id, query.at ? new Date(query.at) : new Date());
  }

  @Get(":id/time-entries/attachable")
  @Roles("owner", "admin")
  attachable(@Param("id") id: string, @CurrentOrg("id") orgId: string) {
    return this.contracts.attachableTimeEntries(orgId, id);
  }

  /** Counts the time entry against this contract's covered hours (non-billable). */
  @Post(":id/time-entries/:timeEntryId")
  @Roles("owner", "admin")
  attach(
    @Param("id") id: string,
    @Param("timeEntryId") timeEntryId: string,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.contracts.setTimeEntry(orgId, id, timeEntryId, true, actorOf(req));
  }

  @Delete(":id/time-entries/:timeEntryId")
  @Roles("owner", "admin")
  detach(
    @Param("id") id: string,
    @Param("timeEntryId") timeEntryId: string,
    @CurrentOrg("id") orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.contracts.setTimeEntry(orgId, id, timeEntryId, false, actorOf(req));
  }
}
