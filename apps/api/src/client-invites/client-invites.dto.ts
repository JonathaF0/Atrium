import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength } from "class-validator";

/** A lead from a CRM (e.g. a Salesforce Flow) to give portal access to. */
export class InviteClientDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  jobTitle?: string;

  /** The record's id in the calling system, kept in the audit log. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalId?: string;

  /** Send a new invitation even when an unexpired one is pending. */
  @IsOptional()
  @IsBoolean()
  resend?: boolean;
}
