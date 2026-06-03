import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { Admin, AdminRole } from './entities/admin.entity';

@Injectable()
export class AdminsService {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
  ) {}

  async findByEmail(email: string): Promise<Admin | null> {
    return this.entityManager.findOne(Admin, { where: { email } });
  }

  async create(
    email: string,
    passwordHash: string,
    role: AdminRole,
    createdByAdminId?: string,
  ): Promise<Admin> {
    const admin = new Admin();
    admin.email = email;
    admin.passwordHash = passwordHash;
    admin.role = role;
    admin.createdBy = createdByAdminId || null;
    admin.isActive = true;

    return this.entityManager.save(Admin, admin);
  }

  async updateLastLogin(adminId: string): Promise<void> {
    await this.entityManager.update(Admin, adminId, {
      lastLoginAt: new Date(),
    });
  }
}
