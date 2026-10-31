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
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { BILLING_TYPES, ESTIMATE_STATUSES, RECURRING_INTERVALS } from "@atrium/shared";
import { PaginationQueryDto } from "../common";

const MAX_CENTS = 1_000_000_000;

export class EstimateLineDto {
  @IsString()
  @IsOptional()
  @MaxLength(50)
  catalogItemId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  group?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  unit?: string;

  @IsIn(BILLING_TYPES as unknown as string[])
  billingType!: string;

  @ValidateIf((o) => o.billingType === "recurring")
  @IsIn(RECURRING_INTERVALS as unknown as string[])
  recurringInterval?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  quantity!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  unitPriceCents!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  @IsOptional()
  costCents?: number | null;

  @IsBoolean()
  @IsOptional()
  taxable?: boolean;

  @IsInt()
  @Min(0)
  @Max(10000)
  @IsOptional()
  taxRateBps?: number;

  @IsBoolean()
  @IsOptional()
  optional?: boolean;

  @IsBoolean()
  @IsOptional()
  selected?: boolean;
}

export class EstimateBodyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  introduction?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  companyId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  recipientUserId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  projectId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  ticketId?: string | null;

  @IsIn(["percent", "amount"])
  @IsOptional()
  discountType?: string | null;

  // basis points for percent, cents for amount
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  @IsOptional()
  discountValue?: number | null;

  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  depositPercent?: number | null;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  assumptions?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  exclusions?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  terms?: string | null;

  @IsDateString()
  @IsOptional()
  validUntil?: string | null;

  @IsBoolean()
  @IsOptional()
  aiDrafted?: boolean;

  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => EstimateLineDto)
  lineItems!: EstimateLineDto[];
}

export class UpdateEstimateDto extends EstimateBodyDto {}

export class EstimateListQueryDto extends PaginationQueryDto {
  @IsIn(ESTIMATE_STATUSES as unknown as string[])
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  search?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  companyId?: string;

  // "open" = sent/viewed/changes_requested
  @IsIn(["open"])
  @IsOptional()
  group?: string;
}

export class EstimateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content!: string;
}

export class ToggleOptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lineItemId!: string;

  @IsBoolean()
  selected!: boolean;
}

export class DeclineEstimateDto {
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  reason?: string;
}

export class AcceptEstimateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  fullName!: string;

  // data:image/png;base64,... from the signature pad
  @IsString()
  @IsNotEmpty()
  @MaxLength(700_000)
  signature!: string;

  @IsBoolean()
  agree!: boolean;
}

export class MilestoneDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  label?: string;

  @IsInt()
  @Min(1)
  @Max(99)
  percent!: number;
}

export class ConvertEstimateDto {
  // "create" a new project, or "existing" uses the estimate's linked project (or projectId)
  @IsIn(["create", "existing"])
  project!: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  projectId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(200)
  projectName?: string;

  @IsIn(["full", "deposit", "milestones"])
  invoices!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  @IsOptional()
  depositPercent?: number;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => MilestoneDto)
  @IsOptional()
  milestones?: MilestoneDto[];
}

export class EstimateSettingsDto {
  @IsString()
  @IsOptional()
  @MaxLength(10)
  estimatePrefix?: string;

  @IsInt()
  @Min(1)
  @Max(365)
  @IsOptional()
  estimateValidDays?: number;

  @IsString()
  @IsOptional()
  @MaxLength(20000)
  estimateDefaultTerms?: string | null;

  @IsBoolean()
  @IsOptional()
  aiAssistEnabled?: boolean;
}

export class AiDraftDto {
  @IsString()
  @IsOptional()
  @MaxLength(10000)
  text?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  ticketId?: string;
}
