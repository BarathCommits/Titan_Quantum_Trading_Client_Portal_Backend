import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

export enum AdminRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  POOL_MANAGER = 'POOL_MANAGER',
  FINANCE_APPROVER = 'FINANCE_APPROVER',
}

@Entity({ schema: 'core', name: 'admins' })
export class Admin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({
    type: 'enum',
    enum: AdminRole,
    default: AdminRole.POOL_MANAGER,
  })
  role: AdminRole;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => Admin, { nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator: Admin | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'deactivated_at', type: 'timestamptz', nullable: true })
  deactivatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
