import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AdminsService } from '../admins/admins.service';
import { UserType, UserStatus } from '../users/entities/user.entity';
import * as bcrypt from 'bcrypt';
import { JwtPayload } from '../common/guards/jwt-auth.guard';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly adminsService: AdminsService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async registerClient(
    email: string,
    password: string,
    tenantId?: string,
    type: UserType = UserType.INDIVIDUAL,
  ) {
    // Check if email already exists in client list
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Check if email already exists in admin list
    const existingAdmin = await this.adminsService.findByEmail(email);
    if (existingAdmin) {
      throw new ConflictException('Email already registered as administrator');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await this.usersService.create(
      email,
      passwordHash,
      tenantId,
      type,
    );

    const tokens = await this.generateTokens({
      id: client.id,
      email: client.email,
      role: 'CLIENT',
      tenantId: client.tenantId,
    });

    return {
      id: client.id,
      email: client.email,
      ...tokens,
    };
  }

  async login(email: string, password: string) {
    // 1. Check if user is an Admin
    const admin = await this.adminsService.findByEmail(email);
    if (admin) {
      if (!admin.isActive) {
        throw new UnauthorizedException(
          'Administrative account is deactivated',
        );
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        admin.passwordHash,
      );
      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      await this.adminsService.updateLastLogin(admin.id);

      const tokens = await this.generateTokens({
        id: admin.id,
        email: admin.email,
        role: admin.role,
      });

      return {
        id: admin.id,
        email: admin.email,
        role: admin.role,
        ...tokens,
      };
    }

    // 2. Check if user is a Client
    const client = await this.usersService.findByEmail(email);
    if (client) {
      if (client.status === UserStatus.SUSPENDED) {
        throw new UnauthorizedException('Client account is suspended');
      }

      const isPasswordValid = await bcrypt.compare(
        password,
        client.passwordHash,
      );
      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const tokens = await this.generateTokens({
        id: client.id,
        email: client.email,
        role: 'CLIENT',
        tenantId: client.tenantId,
      });

      return {
        id: client.id,
        email: client.email,
        role: 'CLIENT',
        ...tokens,
      };
    }

    throw new UnauthorizedException('Invalid credentials');
  }

  async refreshTokens(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        refreshToken,
        {
          secret: this.configService.get<string>(
            'REFRESH_TOKEN_SECRET',
            'super_secret_refresh_jwt_key_for_titan_funds_v1_2026_dev',
          ),
        },
      );

      // Verify the user/admin still exists
      if (payload.role === 'CLIENT') {
        const client = await this.usersService.findByEmail(payload.email);
        if (!client || client.status === UserStatus.SUSPENDED) {
          throw new UnauthorizedException('User is no longer active');
        }
        return this.generateTokens({
          id: client.id,
          email: client.email,
          role: 'CLIENT',
          tenantId: client.tenantId,
        });
      } else {
        const admin = await this.adminsService.findByEmail(payload.email);
        if (!admin || !admin.isActive) {
          throw new UnauthorizedException('Admin is no longer active');
        }
        return this.generateTokens({
          id: admin.id,
          email: admin.email,
          role: admin.role,
        });
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private async generateTokens(user: {
    id: string;
    email: string;
    role: string;
    tenantId?: string;
  }) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>(
          'JWT_SECRET',
          'super_secret_jwt_key_for_titan_funds_v1_2026_dev',
        ),
        expiresIn: this.configService.get<string>(
          'JWT_EXPIRATION',
          '900s',
        ) as unknown as number,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>(
          'REFRESH_TOKEN_SECRET',
          'super_secret_refresh_jwt_key_for_titan_funds_v1_2026_dev',
        ),
        expiresIn: this.configService.get<string>(
          'REFRESH_TOKEN_EXPIRATION',
          '7d',
        ) as unknown as number,
      }),
    ]);

    return { accessToken, refreshToken };
  }
}
