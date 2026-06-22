import { IsNotEmpty, IsString } from 'class-validator';

export class SignAgreementDto {
  @IsNotEmpty()
  @IsString()
  version!: string;
}
