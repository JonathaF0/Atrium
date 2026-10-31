import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import {
  AUTOMATION_TRIGGERS,
  TICKET_LEVELS,
  TICKET_PRIORITIES,
  TICKET_QUEUE_VIEWS,
  TICKET_STATUSES,
} from "@atrium/shared";
import { PaginationQueryDto } from "../common";

const ID_MAX = 64;
const SUBJECT_MAX = 200;
const BODY_MAX = 50_000;

export class CreatePortalTicketDto {
  @IsString() @MinLength(3) @MaxLength(SUBJECT_MAX) subject!: string;
  @IsString() @MinLength(1) @MaxLength(BODY_MAX) description!: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) categoryId?: string;
  @IsOptional() @IsIn(TICKET_LEVELS) impact?: (typeof TICKET_LEVELS)[number];
  @IsOptional() @IsIn(TICKET_LEVELS) urgency?: (typeof TICKET_LEVELS)[number];
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: (typeof TICKET_PRIORITIES)[number];
  @IsOptional() @IsString() @MaxLength(ID_MAX) projectId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) assetId?: string;
}

export class CreateStaffTicketDto {
  @IsString() @MinLength(1) @MaxLength(SUBJECT_MAX) subject!: string;
  @IsString() @MinLength(1) @MaxLength(BODY_MAX) description!: string;
  /** The contact the ticket is raised for. Without one, `requesterEmail` is used. */
  @IsOptional() @IsString() @MaxLength(ID_MAX) contactId?: string;
  @IsOptional() @IsEmail() @MaxLength(320) requesterEmail?: string;
  @IsOptional() @IsString() @MaxLength(200) requesterName?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) categoryId?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: (typeof TICKET_PRIORITIES)[number];
  @IsOptional() @IsIn(TICKET_LEVELS) impact?: (typeof TICKET_LEVELS)[number];
  @IsOptional() @IsIn(TICKET_LEVELS) urgency?: (typeof TICKET_LEVELS)[number];
  @IsOptional() @IsString() @MaxLength(ID_MAX) assigneeId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) projectId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) companyId?: string;
}

export class PortalTicketQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn([...TICKET_STATUSES, "active", "done"]) status?: string;
  @IsOptional() @IsString() @MaxLength(SUBJECT_MAX) q?: string;
  /** Company admins: "mine" limits to their own tickets. */
  @IsOptional() @IsIn(["mine", "company"]) scope?: "mine" | "company";
}

export class StaffTicketQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(TICKET_QUEUE_VIEWS) view?: (typeof TICKET_QUEUE_VIEWS)[number];
  @IsOptional() @IsIn(TICKET_STATUSES) status?: string;
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) categoryId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) companyId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) assigneeId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) labelId?: string;
  @IsOptional() @IsString() @MaxLength(SUBJECT_MAX) q?: string;
}

export class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(BODY_MAX) body!: string;
}

export class StaffReplyDto extends ReplyDto {
  @IsOptional() @IsIn(["public", "internal"]) visibility?: "public" | "internal";
  /** Status to set together with a public reply (e.g. waiting_client). */
  @IsOptional() @IsIn(TICKET_STATUSES) status?: (typeof TICKET_STATUSES)[number];
}

export class CsatDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(5) rating!: number;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class UpdateTicketDto {
  @IsOptional() @IsIn(TICKET_STATUSES) status?: (typeof TICKET_STATUSES)[number];
  @IsOptional() @IsIn(TICKET_PRIORITIES) priority?: (typeof TICKET_PRIORITIES)[number];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(SUBJECT_MAX) subject?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) categoryId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) assigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) companyId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) projectId?: string | null;
}

/** Accepting a triage ticket: tie it to a contact (and their company) or just a company. */
export class AcceptTriageDto {
  @IsOptional() @IsString() @MaxLength(ID_MAX) contactId?: string;
  @IsOptional() @IsString() @MaxLength(ID_MAX) companyId?: string;
}

export const BULK_ACTIONS = ["assign", "status", "priority", "add_label", "close"] as const;

export class BulkTicketsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(ID_MAX, { each: true }) ids!: string[];
  @IsIn(BULK_ACTIONS) action!: (typeof BULK_ACTIONS)[number];
  @IsOptional() @IsString() @MaxLength(ID_MAX) value?: string;
}

export class MergeTicketsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(ID_MAX, { each: true }) sourceIds!: string[];
}

export class SplitTicketDto {
  @IsString() @MaxLength(ID_MAX) messageId!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(SUBJECT_MAX) subject?: string;
}

export class LinkTicketDto {
  @IsString() @MaxLength(ID_MAX) relatedTicketId!: string;
  @IsOptional() @IsIn(["related", "duplicate"]) type?: "related" | "duplicate";
}

export class TicketLabelDto {
  @IsString() @MaxLength(ID_MAX) labelId!: string;
}

export class TicketTimeDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(24 * 60) minutes!: number;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsBoolean() billable?: boolean;
  /** When the work happened; defaults to now (the entry ends at this time). */
  @IsOptional() @IsString() @MaxLength(40) endedAt?: string;
}

export class ConvertToProjectDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
}

export class ConvertToTaskDto {
  @IsString() @MaxLength(ID_MAX) projectId!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(255) title?: string;
}

// ─── Settings ───

export class HelpdeskSettingsDto {
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9]{1,9}$/) ticketPrefix?: string;
  @IsOptional() @IsBoolean() autoAcknowledge?: boolean;
  @IsOptional() @IsBoolean() csatEnabled?: boolean;
  @IsOptional() @IsBoolean() clientsCanClose?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) closeResolvedAfterDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) closeWaitingAfterDays?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) triageAssigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) defaultSlaPolicyId?: string | null;
}

export class InboundSettingsDto {
  @IsOptional() @IsIn(["none", "webhook", "imap"]) inboundMode?: "none" | "webhook" | "imap";
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== "") @IsEmail() @MaxLength(320) inboundAddress?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== "") @IsString() @MaxLength(255) imapHost?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @Type(() => Number) @IsInt() @Min(1) @Max(65535) imapPort?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null && v !== "") @IsString() @MaxLength(320) imapUser?: string | null;
  /** Write-only; empty string clears it. */
  @IsOptional() @IsString() @MaxLength(500) imapPass?: string;
  @IsOptional() @IsBoolean() imapSecure?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) imapMailbox?: string;
}

export class CategoryDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/) color?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) order?: number;
  @IsOptional() @IsIn(TICKET_PRIORITIES) defaultPriority?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) defaultAssigneeId?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) slaPolicyId?: string | null;
  @IsOptional() @IsBoolean() portalVisible?: boolean;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class UpdateCategoryDto extends CategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) declare name: string;
}

export class SlaPolicyDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  /** { low|normal|high|urgent: { firstResponseMins, resolutionMins } }; validated in the service. */
  @IsObject() targets!: Record<string, { firstResponseMins: number; resolutionMins: number }>;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) businessHoursId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(99) warnAtPercent?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) escalateToId?: string | null;
}

export class UpdateSlaPolicyDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsObject() targets?: Record<string, { firstResponseMins: number; resolutionMins: number }>;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) businessHoursId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(99) warnAtPercent?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) escalateToId?: string | null;
}

export class BusinessWindowDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(6) day!: number;
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) start!: string;
  @Matches(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/) end!: string;
}

export class BusinessHoursDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MaxLength(100) timezone!: string;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => BusinessWindowDto) schedule!: BusinessWindowDto[];
}

export class UpdateBusinessHoursDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) timezone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => BusinessWindowDto) schedule?: BusinessWindowDto[];
}

export class HolidayDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
}

export class CannedResponseDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(BODY_MAX) body!: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) categoryId?: string | null;
  /** Personal responses are visible only to their owner. */
  @IsOptional() @IsBoolean() personal?: boolean;
}

export class UpdateCannedResponseDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(BODY_MAX) body?: string;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(ID_MAX) categoryId?: string | null;
  @IsOptional() @IsBoolean() personal?: boolean;
}

export class RenderCannedDto {
  @IsString() @MaxLength(ID_MAX) ticketId!: string;
}

export class AutomationRuleDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsIn(AUTOMATION_TRIGGERS) trigger!: (typeof AUTOMATION_TRIGGERS)[number];
  /** Validated against the shared vocabulary in the service. */
  @IsArray() @ArrayMaxSize(20) conditions!: unknown[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) actions!: unknown[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) order?: number;
}

export class UpdateAutomationRuleDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsIn(AUTOMATION_TRIGGERS) trigger?: (typeof AUTOMATION_TRIGGERS)[number];
  @IsOptional() @IsArray() @ArrayMaxSize(20) conditions?: unknown[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) actions?: unknown[];
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000) order?: number;
}
