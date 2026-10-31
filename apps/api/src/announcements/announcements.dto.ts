import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from "class-validator";
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_SEVERITIES,
  ANNOUNCEMENT_TYPES,
  INCIDENT_STATES,
} from "@atrium/shared";
import { PaginationQueryDto } from "../common";

export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "published", "expired"] as const;
export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;
export const IMPACT_MAX = 500;
export const AUDIENCE_VALUE_MAX = 100;
export const MAX_AUDIENCE_COMPANIES = 500;
export const MAX_CATEGORY_IDS = 50;
export const ID_MAX = 64;

export class AudienceDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_AUDIENCES)
  audienceType?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(AUDIENCE_VALUE_MAX)
  audienceValue?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AUDIENCE_COMPANIES)
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  companyIds?: string[];
}

export class UpdateAnnouncementDto extends AudienceDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_TYPES)
  type?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_SEVERITIES)
  severity?: string;

  @IsOptional()
  @IsIn(INCIDENT_STATES)
  incidentState?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BODY_MAX)
  body?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(IMPACT_MAX)
  impact?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  windowStart?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  windowEnd?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(BODY_MAX)
  postmortem?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CATEGORY_IDS)
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsBoolean()
  publicStatus?: boolean;

  @IsOptional()
  @IsBoolean()
  emailOnPublish?: boolean;

  @IsOptional()
  @IsBoolean()
  pushOnPublish?: boolean;
}

export class CreateAnnouncementDto extends UpdateAnnouncementDto {
  /** Prefills type, severity, title and body; explicit fields win. */
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  templateId?: string;
}

export class ScheduleAnnouncementDto {
  @IsDateString()
  publishAt!: string;
}

export class AnnouncementUpdatePostDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(BODY_MAX)
  body!: string;

  @IsOptional()
  @IsIn(INCIDENT_STATES)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BODY_MAX)
  postmortem?: string;

  /** Send email/push for this update when the announcement opted in. Defaults to true. */
  @IsOptional()
  @IsBoolean()
  notify?: boolean;
}

export class AnnouncementListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_TYPES)
  type?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_TYPES)
  type?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_SEVERITIES)
  severity?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(BODY_MAX)
  body?: string;
}

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsIn(ANNOUNCEMENT_TYPES)
  type!: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_SEVERITIES)
  severity?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(TITLE_MAX)
  title!: string;

  @IsString()
  @MaxLength(BODY_MAX)
  body!: string;
}

export class StatusPageSettingsDto {
  @IsBoolean()
  statusPageEnabled!: boolean;
}
