import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { User, UserType, UserStatus, KYCStatus } from './entities/user.entity';
import { getManager } from '../common/rls-context';
import { randomUUID } from 'crypto';

@Injectable()
export class UsersService {
  constructor(
    @InjectEntityManager()
    private readonly defaultEntityManager: EntityManager,
  ) {}

  private get manager(): EntityManager {
    return getManager(this.defaultEntityManager);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.manager.findOne(User, { where: { email } });
  }

  async create(
    email: string,
    passwordHash: string,
    tenantId?: string,
    type: UserType = UserType.INDIVIDUAL,
  ): Promise<User> {
    const finalTenantId = tenantId || randomUUID();
    const user = new User();
    user.email = email;
    user.passwordHash = passwordHash;
    user.tenantId = finalTenantId;
    user.type = type;
    user.status = UserStatus.PENDING_PROFILE;
    user.kycStatus = KYCStatus.NOT_STARTED;

    return this.manager.save(User, user);
  }
}
