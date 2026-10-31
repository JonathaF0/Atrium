import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

export class ReportQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "from must be a date (YYYY-MM-DD)" })
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "to must be a date (YYYY-MM-DD)" })
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  companyId?: string;

  @IsOptional()
  @IsIn(["day", "week", "month"])
  bucket?: "day" | "week" | "month";
}

export class SlaExportQueryDto extends ReportQueryDto {
  @IsOptional()
  @IsIn(["summary", "breached"])
  table?: "summary" | "breached";
}
