import {
  IsNotEmpty,
  IsString,
  ValidateNested,
  IsObject,
  IsEnum,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserType } from '../entities/user.entity';

export class BankRoutingInfoDto {
  @IsNotEmpty()
  @IsString()
  bic!: string;

  @IsNotEmpty()
  @IsString()
  bankName!: string;
}

export class SaveProfileDto {
  @IsNotEmpty()
  @IsEnum(UserType)
  type!: UserType;

  @IsNotEmpty()
  @IsString()
  fullName!: string;

  @ValidateIf((o: SaveProfileDto) => o.type === UserType.ENTERPRISE)
  @IsNotEmpty({ message: 'contactPerson is required for ENTERPRISE clients' })
  @IsString()
  contactPerson?: string;

  @IsNotEmpty()
  @IsString()
  phone!: string;

  @IsNotEmpty()
  @IsString()
  address!: string;

  @IsNotEmpty()
  @IsString()
  city!: string;

  @IsNotEmpty()
  @IsString()
  country!: string;

  @IsNotEmpty()
  @IsString()
  bankAccountNumber!: string;

  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => BankRoutingInfoDto)
  bankRoutingInfo!: BankRoutingInfoDto;
}
