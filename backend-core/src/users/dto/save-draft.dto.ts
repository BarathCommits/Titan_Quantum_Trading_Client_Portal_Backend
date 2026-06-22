import { IsNotEmpty, IsObject } from 'class-validator';

export class SaveDraftDto {
  @IsNotEmpty()
  @IsObject()
  payload!: Record<string, unknown>;
}
