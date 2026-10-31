import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, MaxLength, Min, ValidateIf } from "class-validator";
import { CLIENT_DOC_SECTIONS } from "@atrium/shared";
import type { ClientDocSection } from "@atrium/shared";

export const CLIENT_DOC_BODY_MAX = 50_000;

class ClientDocFieldsDto {
  @IsOptional()
  @IsIn(CLIENT_DOC_SECTIONS)
  section?: ClientDocSection;

  @IsOptional()
  @IsString()
  @MaxLength(CLIENT_DOC_BODY_MAX)
  body?: string;

  /** Link to the password vault entry; secrets are never stored here. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false }, { message: "vaultUrl must be an https:// URL" })
  @MaxLength(2000)
  vaultUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  order?: number;
}

export class CreateClientDocDto extends ClientDocFieldsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  companyId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;
}

export class UpdateClientDocDto extends ClientDocFieldsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;
}

export class ListClientDocsQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  companyId!: string;
}
