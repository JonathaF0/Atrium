import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { CONTRACT_TYPES } from "@atrium/shared";
import type { ContractType } from "@atrium/shared";
import { PaginationQueryDto } from "../common";
import { CONTRACT_STATUSES, COVERAGE_PERIODS } from "./contract-period";
import type { ContractStatus, CoveragePeriod } from "./contract-period";

const nullable = (_: unknown, v: unknown): boolean => v !== null;

export const CONTRACT_NAME_MAX = 200;
export const CONTRACT_NOTES_MAX = 5000;
export const SERVICE_NAME_MAX = 200;
export const MAX_SERVICES = 50;
export const MAX_COVERED_MINUTES = 1_000_000;

class ContractFieldsDto {
  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  type?: ContractType;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  @MaxLength(40)
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  renewalNoticeDays?: number;

  /** Minutes included per coverage period; null = no hours included. */
  @IsOptional()
  @ValidateIf(nullable)
  @IsInt()
  @Min(0)
  @Max(MAX_COVERED_MINUTES)
  coveredMinutes?: number | null;

  @IsOptional()
  @IsIn(COVERAGE_PERIODS)
  coveragePeriod?: CoveragePeriod;

  @IsOptional()
  @ValidateIf(nullable)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  overageRateCents?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SERVICES)
  @IsString({ each: true })
  @MaxLength(SERVICE_NAME_MAX, { each: true })
  includedServices?: string[];

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(100)
  slaPolicyId?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsUrl({ protocols: ["https"], require_protocol: true, require_valid_protocol: true })
  @MaxLength(2000)
  documentUrl?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(CONTRACT_NOTES_MAX)
  notes?: string | null;
}

export class UpdateContractDto extends ContractFieldsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTRACT_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(40)
  startsAt?: string;
}

export class CreateContractDto extends ContractFieldsDto {
  @IsString()
  @MaxLength(100)
  companyId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(CONTRACT_NAME_MAX)
  name!: string;

  @IsDateString()
  @MaxLength(40)
  startsAt!: string;
}

export class ListContractsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;

  @IsOptional()
  @IsIn(CONTRACT_TYPES)
  type?: ContractType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  /** Only contracts ending within the next N days. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  endingWithinDays?: number;
}

export class UsageQueryDto {
  /** Any moment inside the period to report; defaults to now. */
  @IsOptional()
  @IsDateString()
  @MaxLength(40)
  at?: string;
}
