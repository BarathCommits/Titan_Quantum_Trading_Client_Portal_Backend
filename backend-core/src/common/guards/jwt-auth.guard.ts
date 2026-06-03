import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Request } from 'express';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  tenantId?: string;
}

export interface RequestWithUser extends Request {
  user?: JwtPayload;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token missing');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret:
          process.env.JWT_SECRET ||
          'super_secret_jwt_key_for_titan_funds_v1_2026_dev',
      });
      request.user = payload;
    } catch {
      throw new UnauthorizedException(
        'Invalid or expired authentication token',
      );
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | null {
    const authorization = request.headers.authorization;
    if (!authorization) {
      return null;
    }
    const [type, token] = authorization.split(' ');
    return type === 'Bearer' ? token : null;
  }
}
