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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { KB_ARTICLE_STATUSES, KB_VISIBILITIES } from "@atrium/shared";
import type { KbArticleStatus, KbVisibility } from "@atrium/shared";
import { PaginationQueryDto } from "../common";

export const KB_TITLE_MAX = 200;
export const KB_BODY_MAX = 100_000;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MESSAGE = "slug may contain lowercase letters, digits and single dashes";

class KbCollectionFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  order?: number;

  @IsOptional()
  @IsIn(KB_VISIBILITIES)
  visibility?: KbVisibility;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  audienceCompanyIds?: string[];
}

export class CreateKbCollectionDto extends KbCollectionFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}

export class UpdateKbCollectionDto extends KbCollectionFieldsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;
}

class KbArticleFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(SLUG_PATTERN, { message: SLUG_MESSAGE })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(KB_BODY_MAX)
  body?: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  collectionId?: string | null;

  @IsOptional()
  @IsIn(KB_VISIBILITIES)
  visibility?: KbVisibility;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  ownerId?: string | null;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  @MaxLength(40)
  reviewBy?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  labelIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  audienceCompanyIds?: string[];
}

export class CreateKbArticleDto extends KbArticleFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(KB_TITLE_MAX)
  title!: string;
}

export class UpdateKbArticleDto extends KbArticleFieldsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(KB_TITLE_MAX)
  title?: string;

  /** Optional note stored on the revision this save creates. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  revisionNote?: string;
}

export class ListKbArticlesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(KB_ARTICLE_STATUSES)
  status?: KbArticleStatus;

  @IsOptional()
  @IsIn(KB_VISIBILITIES)
  visibility?: KbVisibility;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ownerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  collectionId?: string;

  /** "stale" = review date has passed. */
  @IsOptional()
  @IsIn(["stale", "upcoming"])
  review?: "stale" | "upcoming";

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class KbSettingsDto {
  @IsOptional()
  @IsBoolean()
  kbPublicEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  kbReviewDays?: number;
}

export class KbSearchQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class KbReaderListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  collectionId?: string;
}

export class KbSuggestQueryDto {
  @IsString()
  @MaxLength(200)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  categoryId?: string;
}

export class KbFeedbackDto {
  @IsBoolean()
  helpful!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class KbDeflectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  articleId!: string;

  @IsIn(["viewed", "deflected"])
  outcome!: "viewed" | "deflected";
}

export class KbRestoreRevisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
