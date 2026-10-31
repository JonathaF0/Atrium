import { IsDateString, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { PaginationQueryDto } from "../common";

export class AuditLogQueryDto extends PaginationQueryDto {
  /** Matches actions starting with this, e.g. "auth." or "invoice". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9_.]*$/i, { message: "action may only contain letters, digits, dots and underscores" })
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  actorId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetId?: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsDateString()
  @MaxLength(40)
  to?: string;
}
