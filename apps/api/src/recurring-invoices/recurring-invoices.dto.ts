import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { RECURRING_INTERVALS } from "@atrium/shared";
import { PaginationQueryDto } from "../common";

export const SCHEDULE_STATUSES = ["active", "paused", "ended"] as const;

export class RecurringItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;

  @IsInt()
  @Min(0)
  @Max(100_000_000)
  unitPrice!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  taxRateBps?: number;
}

export class CreateRecurringInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  companyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  recipientUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string | null;

  @IsIn(RECURRING_INTERVALS as unknown as string[])
  interval!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  intervalCount?: number;

  @IsDateString()
  @MaxLength(40)
  startDate!: string;

  @IsOptional()
  @ValidateIf((o) => o.endDate !== null)
  @IsDateString()
  @MaxLength(40)
  endDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  dueDays?: number;

  @IsOptional()
  @IsBoolean()
  prorateFirst?: boolean;

  @IsOptional()
  @IsBoolean()
  autoSend?: boolean;

  @IsOptional()
  @IsBoolean()
  autoCharge?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecurringItemDto)
  items!: RecurringItemDto[];
}

export class UpdateRecurringInvoiceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  companyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  recipientUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  projectId?: string | null;

  @IsOptional()
  @IsIn(RECURRING_INTERVALS as unknown as string[])
  interval?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  intervalCount?: number;

  @IsOptional()
  @IsDateString()
  @MaxLength(40)
  startDate?: string;

  @IsOptional()
  @ValidateIf((o) => o.endDate !== null)
  @IsDateString()
  @MaxLength(40)
  endDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  dueDays?: number;

  @IsOptional()
  @IsBoolean()
  prorateFirst?: boolean;

  @IsOptional()
  @IsBoolean()
  autoSend?: boolean;

  @IsOptional()
  @IsBoolean()
  autoCharge?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsIn(SCHEDULE_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RecurringItemDto)
  items?: RecurringItemDto[];
}

export class RecurringListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(SCHEDULE_STATUSES as unknown as string[])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  companyId?: string;
}

export class ConfirmCardDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  sessionId!: string;
}
