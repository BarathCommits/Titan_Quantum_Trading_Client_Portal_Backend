import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { UserProfile } from './entities/profile.entity';
import { User, UserStatus, UserType } from './entities/user.entity';
import { OnboardingDraft } from './entities/draft.entity';
import { getManager } from '../common/rls-context';
import { encryptPII, decryptPII } from '../common/utils/crypto';
import { ConfigService } from '@nestjs/config';

export interface BankRoutingInfo {
  bic: string;
  bankName: string;
}

export interface SaveProfileInput {
  type: UserType;
  fullName: string;
  contactPerson?: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  bankAccountNumber: string;
  bankRoutingInfo: BankRoutingInfo;
}

@Injectable()
export class ProfilesService {
  private readonly encryptionKey: string;

  constructor(
    @InjectEntityManager()
    private readonly defaultEntityManager: EntityManager,
    configService: ConfigService,
  ) {
    const key = configService.get<string>('ENCRYPTION_KEY');
    if (!key) {
      throw new Error('ENCRYPTION_KEY environment variable is not configured');
    }
    this.encryptionKey = key;
  }

  private get manager(): EntityManager {
    return getManager(this.defaultEntityManager);
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    const profile = await this.manager.findOne(UserProfile, {
      where: { userId },
    });

    if (!profile) {
      return null;
    }

    const key = this.encryptionKey;
    profile.phone = decryptPII(profile.phone, key);
    profile.address = decryptPII(profile.address, key);
    profile.bankAccountNumber = decryptPII(profile.bankAccountNumber, key);
    profile.bankRoutingInfo = JSON.parse(
      decryptPII(profile.bankRoutingInfo, key),
    ) as string;

    return profile;
  }

  async saveProfile(
    userId: string,
    data: SaveProfileInput,
  ): Promise<UserProfile> {
    const user = await this.manager.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    let profile = await this.manager.findOne(UserProfile, {
      where: { userId },
    });

    if (!profile) {
      profile = new UserProfile();
      profile.userId = userId;
    }

    user.type = data.type;

    const key = this.encryptionKey;

    // Encrypt sensitive PII fields
    profile.fullName = data.fullName;
    profile.contactPerson = data.contactPerson || null;
    profile.phone = encryptPII(data.phone, key);
    profile.address = encryptPII(data.address, key);
    profile.city = data.city;
    profile.country = data.country;
    profile.bankAccountNumber = encryptPII(data.bankAccountNumber, key);
    profile.bankRoutingInfo = encryptPII(
      JSON.stringify(data.bankRoutingInfo),
      key,
    );
    profile.currencyPreference = 'EUR'; // Fixed in V1

    const savedProfile = await this.manager.save(UserProfile, profile);

    // Transition state from PENDING_PROFILE to PENDING_AGREEMENT
    if (user.status === UserStatus.PENDING_PROFILE) {
      user.status = UserStatus.PENDING_AGREEMENT;
    }
    await this.manager.save(User, user);

    // Clear onboarding draft on successful submit
    await this.manager.delete(OnboardingDraft, { userId });

    savedProfile.phone = data.phone;
    savedProfile.address = data.address;
    savedProfile.bankAccountNumber = data.bankAccountNumber;
    savedProfile.bankRoutingInfo = data.bankRoutingInfo as unknown as string;
    return savedProfile;
  }

  async signAgreement(
    userId: string,
    version: string,
    ipAddress: string,
    userAgent: string,
  ): Promise<{ success: boolean; userStatus: UserStatus; signedAt: Date }> {
    const user = await this.manager.findOne(User, { where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify user has setup profile first
    if (user.status === UserStatus.PENDING_PROFILE) {
      throw new BadRequestException(
        'Complete user profile setup before signing agreements',
      );
    }

    const signedAt = new Date();

    // Transition state to PENDING_INVESTMENT
    if (user.status === UserStatus.PENDING_AGREEMENT) {
      user.status = UserStatus.PENDING_INVESTMENT;
      await this.manager.save(User, user);
    }

    // Write audit trail log entry
    await this.manager.query(
      `INSERT INTO core.audit_log (actor_id, actor_type, action, entity_type, entity_id, after_state, ip_address) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        'USER',
        'SIGN_AGREEMENT',
        'USER',
        userId,
        JSON.stringify({
          agreementVersion: version,
          signedAt,
          ipAddress,
          userAgent,
        }),
        ipAddress,
      ],
    );

    // Write outbox event to send confirmation receipt (transactional outbox pattern)
    await this.manager.query(
      `INSERT INTO core.outbox_events (event_type, payload, published) 
       VALUES ($1, $2, $3)`,
      [
        'AGREEMENT_SIGNED',
        JSON.stringify({
          userId,
          agreementVersion: version,
          signedAt,
          ipAddress,
        }),
        false,
      ],
    );

    return {
      success: true,
      userStatus: user.status,
      signedAt,
    };
  }

  async saveDraft(
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<OnboardingDraft> {
    let draft = await this.manager.findOne(OnboardingDraft, {
      where: { userId },
    });

    if (!draft) {
      draft = new OnboardingDraft();
      draft.userId = userId;
    }

    draft.payload = payload;
    return this.manager.save(OnboardingDraft, draft);
  }

  async getDraft(userId: string): Promise<Record<string, unknown> | null> {
    const draft = await this.manager.findOne(OnboardingDraft, {
      where: { userId },
    });

    if (!draft) {
      return null;
    }

    return draft.payload;
  }
}
