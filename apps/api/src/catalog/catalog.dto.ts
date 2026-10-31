import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { BILLING_TYPES, RECURRING_INTERVALS } from "@atrium/shared";
import { PaginationQueryDto } from "../common";

const MAX_CENTS = 1_000_000_000;

export class CatalogItemDto {
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
  @MaxLength(100)
  category?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  unit?: string;

  @IsIn(BILLING_TYPES as unknown as string[])
  billingType!: string;

  @ValidateIf((o) => o.billingType === "recurring")
  @IsIn(RECURRING_INTERVALS as unknown as string[])
  recurringInterval?: string | null;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  rateCents!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  @IsOptional()
  costCents?: number | null;

  @IsBoolean()
  @IsOptional()
  taxable?: boolean;
}

export class UpdateCatalogItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  unit?: string;

  @IsIn(BILLING_TYPES as unknown as string[])
  @IsOptional()
  billingType?: string;

  @IsIn(RECURRING_INTERVALS as unknown as string[])
  @IsOptional()
  recurringInterval?: string | null;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  @IsOptional()
  rateCents?: number;

  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  @IsOptional()
  costCents?: number | null;

  @IsBoolean()
  @IsOptional()
  taxable?: boolean;

  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}

export class CatalogListQueryDto extends PaginationQueryDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  search?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string;

  @IsIn(["true", "false"])
  @IsOptional()
  archived?: string;
}

export class BundleItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  catalogItemId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  quantity!: number;

  @IsBoolean()
  @IsOptional()
  optional?: boolean;
}

export class CatalogBundleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  items!: BundleItemDto[];
}

export class UpdateCatalogBundleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => BundleItemDto)
  @IsOptional()
  items?: BundleItemDto[];

  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}
