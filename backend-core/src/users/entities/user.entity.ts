import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
} from 'typeorm';
import { UserProfile } from './profile.entity';

export enum UserType {
  INDIVIDUAL = 'INDIVIDUAL',
  ENTERPRISE = 'ENTERPRISE',
}

export enum UserStatus {
  PENDING_PROFILE = 'PENDING_PROFILE',
  PENDING_AGREEMENT = 'PENDING_AGREEMENT',
  PENDING_INVESTMENT = 'PENDING_INVESTMENT',
  PENDING_DEPOSIT = 'PENDING_DEPOSIT',
  ACTIVE = 'ACTIVE',
  MATURED = 'MATURED',
  SUSPENDED = 'SUSPENDED',
  CLOSED = 'CLOSED',
  GDPR_ANONYMISED = 'GDPR_ANONYMISED',
}

export enum KYCStatus {
  NOT_STARTED = 'NOT_STARTED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity({ schema: 'core', name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({
    type: 'enum',
    enum: UserType,
    default: UserType.INDIVIDUAL,
  })
  type: UserType;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.PENDING_PROFILE,
  })
  status: UserStatus;

  @Column({
    name: 'kyc_status',
    type: 'enum',
    enum: KYCStatus,
    default: KYCStatus.NOT_STARTED,
  })
  kycStatus: KYCStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => UserProfile, (profile) => profile.user)
  profile: UserProfile;
}
