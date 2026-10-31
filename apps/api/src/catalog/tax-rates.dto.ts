import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class CreateTaxRateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  // Basis points: 825 = 8.25%
  @IsInt()
  @Min(0)
  @Max(10000)
  rateBps!: number;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateTaxRateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @IsInt()
  @Min(0)
  @Max(10000)
  @IsOptional()
  rateBps?: number;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;

  @IsBoolean()
  @IsOptional()
  archived?: boolean;
}
