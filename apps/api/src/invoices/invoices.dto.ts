import { Type } from "class-transformer";
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  ValidateIf,
  IsIn,
  IsDateString,
  MaxLength,
} from "class-validator";
import { PaginationQueryDto } from "../common";

export class LineItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsInt()
  @Min(0)
  unitPrice!: number;

  // Basis points (825 = 8.25%). Omitted or 0 means the line is not taxed.
  @IsInt()
  @Min(0)
  @Max(10000)
  @IsOptional()
  taxRateBps?: number;
}

export class CreateInvoiceDto {
  @IsString()
  @IsOptional()
  projectId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  lineItems!: LineItemDto[];

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateInvoiceDto {
  @IsString()
  @IsOptional()
  @IsIn(["draft", "sent", "paid", "overdue", "cancelled"])
  status?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LineItemDto)
  @IsOptional()
  lineItems?: LineItemDto[];

  @ValidateIf((o) => o.dueDate !== null)
  @IsDateString()
  @IsOptional()
  dueDate?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;

  // Only honoured when the invoice transitions to paid.
  @IsDateString()
  @IsOptional()
  paidAt?: string;
}

export class CreateUploadedInvoiceDto {
  @IsString()
  @IsOptional()
  projectId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount!: number;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class MineInvoiceQueryDto extends PaginationQueryDto {
  @IsString()
  @IsOptional()
  projectId?: string;
}

export class InvoiceListQueryDto extends PaginationQueryDto {
  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  @IsIn(["draft", "sent", "paid", "overdue", "cancelled"])
  status?: string;
}
