import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { TWO_FACTOR_SCOPES } from "./two-factor-policy";

export class UpdateSecuritySettingsDto {
  @IsOptional()
  @IsBoolean()
  requireTwoFactor?: boolean;

  @IsOptional()
  @IsIn(TWO_FACTOR_SCOPES as unknown as string[])
  twoFactorScope?: string;
}

export class SaveSsoProviderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  issuer!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  clientId!: string;

  // Optional on update: leaving it out keeps the stored secret.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  clientSecret?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  domain!: string;
}
