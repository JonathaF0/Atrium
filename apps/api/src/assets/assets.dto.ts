import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ASSET_TYPES } from "@atrium/shared";
import type { AssetType } from "@atrium/shared";
import { PaginationQueryDto } from "../common";
import {
  ASSET_EXTERNAL_ID_MAX,
  ASSET_NAME_MAX,
  ASSET_NOTES_MAX,
  ASSET_SEATS_MAX,
  ASSET_STATUSES,
  ASSET_TEXT_MAX,
} from "./asset-fields";
import type { AssetMetadata, AssetStatus } from "./asset-fields";
import { MAX_SYNC_BATCH } from "./asset-sync";

const nullable = (_: unknown, v: unknown): boolean => v !== null;

/** Fields shared by create, update and sync. `null` clears an optional field. */
class AssetFieldsDto {
  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(ASSET_TEXT_MAX)
  vendor?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(ASSET_TEXT_MAX)
  model?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(ASSET_TEXT_MAX)
  serialNumber?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(ASSET_TEXT_MAX)
  assignedTo?: string | null;

  @IsOptional()
  @IsIn(ASSET_STATUSES)
  status?: AssetStatus;

  @IsOptional()
  @ValidateIf(nullable)
  @IsInt()
  @Min(0)
  @Max(ASSET_SEATS_MAX)
  seats?: number | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  @MaxLength(40)
  purchaseDate?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  @MaxLength(40)
  warrantyEndsAt?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  @MaxLength(40)
  renewsAt?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(ASSET_NOTES_MAX)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  /** Plain object, at most 50 keys, string/number/boolean values; checked in full by the service. */
  @IsOptional()
  @ValidateIf(nullable)
  @IsObject()
  metadata?: AssetMetadata | null;
}

export class UpdateAssetDto extends AssetFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @IsOptional()
  @IsIn(ASSET_TYPES)
  type?: AssetType;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSET_NAME_MAX)
  name?: string;
}

export class CreateAssetDto extends AssetFieldsDto {
  @IsString()
  @MaxLength(100)
  companyId!: string;

  @IsIn(ASSET_TYPES)
  type!: AssetType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSET_NAME_MAX)
  name!: string;
}

export class ListAssetsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @IsOptional()
  @IsIn(ASSET_TYPES)
  type?: AssetType;

  @IsOptional()
  @IsIn(ASSET_STATUSES)
  status?: AssetStatus;

  /** Only assets whose warranty or renewal date falls within the next N days. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  expiringWithinDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class SyncAssetDto extends AssetFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSET_EXTERNAL_ID_MAX)
  externalId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  companyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @IsIn(ASSET_TYPES)
  type!: AssetType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(ASSET_NAME_MAX)
  name!: string;
}

export class SyncAssetsDto {
  @IsArray()
  @ArrayMaxSize(MAX_SYNC_BATCH)
  @ValidateNested({ each: true })
  @Type(() => SyncAssetDto)
  assets!: SyncAssetDto[];

  /** Retire this source's assets that are not in the batch. */
  @IsOptional()
  @IsBoolean()
  fullSync?: boolean;
}

export class ImportAssetsBodyDto {
  /** JSON object of CSV header -> asset field; omitted = matched from the headers. */
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  mapping?: string;

  /** Create companies named in the file that don't exist yet. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  createCompanies?: boolean;
}
