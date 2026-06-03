import {
  Controller,
  Post,
  Body,
  UseGuards,
  ConflictException,
  HttpStatus,
  HttpCode,
  Req,
} from '@nestjs/common';
import { AdminsService } from './admins.service';
import { AdminRole } from './entities/admin.entity';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import * as bcrypt from 'bcrypt';
import type { RequestWithUser } from '../common/guards/jwt-auth.guard';
import { IsEmail, IsNotEmpty, IsEnum, MinLength } from 'class-validator';

export class CreateAdminDto {
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @MinLength(8)
  password!: string;

  @IsEnum(['SUPER_ADMIN', 'POOL_MANAGER', 'FINANCE_APPROVER'])
  role!: AdminRole;
}

@Controller('api/admins')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminsController {
  constructor(private readonly adminsService: AdminsService) {}

  @Post()
  @Roles(AdminRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  async createAdmin(@Body() dto: CreateAdminDto, @Req() req: RequestWithUser) {
    const existing = await this.adminsService.findByEmail(dto.email);
    if (existing) {
      throw new ConflictException('Admin email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const creatorId = req.user?.sub;

    const admin = await this.adminsService.create(
      dto.email,
      passwordHash,
      dto.role,
      creatorId,
    );

    return {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      createdAt: admin.createdAt,
    };
  }
}
