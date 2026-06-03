import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '../../admins/entities/admin.entity';

export type UserRole = AdminRole | 'CLIENT';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
