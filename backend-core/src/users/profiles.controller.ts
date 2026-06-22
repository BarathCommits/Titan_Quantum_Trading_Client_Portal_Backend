import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  NotFoundException,
  UnauthorizedException,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { SaveProfileDto } from './dto/save-profile.dto';
import { SaveDraftDto } from './dto/save-draft.dto';
import { SignAgreementDto } from './dto/sign-agreement.dto';
import { RlsInterceptor } from '../common/interceptors/rls.interceptor';
import type { RequestWithUser } from '../common/guards/jwt-auth.guard';

@Controller('api/profiles')
@UseInterceptors(RlsInterceptor)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  private getUserId(req: RequestWithUser): string {
    const userId = req.user?.sub;
    if (!userId)
      throw new UnauthorizedException('Authentication user context not found');
    return userId;
  }

  @Get('me')
  async getProfile(@Req() req: RequestWithUser) {
    const userId = this.getUserId(req);
    const profile = await this.profilesService.getProfile(userId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return profile;
  }

  @Post('me')
  async saveProfile(@Req() req: RequestWithUser, @Body() dto: SaveProfileDto) {
    const userId = this.getUserId(req);
    return this.profilesService.saveProfile(userId, dto);
  }

  @Post('sign-agreement')
  @HttpCode(HttpStatus.OK)
  async signAgreement(
    @Req() req: RequestWithUser,
    @Body() dto: SignAgreementDto,
  ) {
    const userId = this.getUserId(req);

    const forwardedFor = req.headers['x-forwarded-for'] as string;
    const ipAddress = forwardedFor
      ? forwardedFor.split(',')[0].trim()
      : req.ip || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'unknown';

    return this.profilesService.signAgreement(
      userId,
      dto.version,
      ipAddress,
      userAgent,
    );
  }

  @Post('draft')
  @HttpCode(HttpStatus.OK)
  async saveDraft(@Req() req: RequestWithUser, @Body() dto: SaveDraftDto) {
    const userId = this.getUserId(req);
    const result = await this.profilesService.saveDraft(userId, dto.payload);
    return { success: true, updatedAt: result.updatedAt };
  }

  @Get('draft')
  async getDraft(@Req() req: RequestWithUser) {
    const userId = this.getUserId(req);
    const draft = await this.profilesService.getDraft(userId);
    if (!draft) {
      throw new NotFoundException('Onboarding draft not found');
    }
    return { payload: draft };
  }
}
