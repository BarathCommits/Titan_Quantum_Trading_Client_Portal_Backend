import {
  Controller,
  Post,
  Body,
  Res,
  Req,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserType } from '../users/entities/user.entity';
import { Public } from '../common/decorators/public.decorator';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MinLength,
} from 'class-validator';
import type { Response } from 'express';
import type { RequestWithUser } from '../common/guards/jwt-auth.guard';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @MinLength(8)
  password!: string;

  @IsOptional()
  tenantId?: string;

  @IsOptional()
  @IsEnum(UserType)
  type?: UserType;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  password!: string;
}

export class RefreshBodyDto {
  @IsNotEmpty()
  refreshToken!: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.registerClient(
      dto.email,
      dto.password,
      dto.tenantId,
      dto.type,
    );

    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return {
      id: result.id,
      email: result.email,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto.email, dto.password);

    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return {
      id: result.id,
      email: result.email,
      role: result.role,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: RequestWithUser,
    @Body() dto: RefreshBodyDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const token = cookies?.refresh_token || dto?.refreshToken;
    if (!token) {
      throw new UnauthorizedException('Refresh token missing');
    }

    const result = await this.authService.refreshTokens(token);

    res.cookie('refresh_token', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return result;
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('refresh_token');
    return { success: true };
  }
}
