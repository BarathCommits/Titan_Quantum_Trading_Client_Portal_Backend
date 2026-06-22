import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';
import cookieParser from 'cookie-parser';

interface AuthResponse {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  tenantId: string;
}

interface DBUser {
  id: string;
  tenant_id: string;
  email: string;
  status: string;
}

interface RawProfileRow {
  id: string;
  user_id: string;
  full_name: string;
  contact_person: string | null;
  phone: string;
  address: string;
  city: string;
  country: string;
  bank_account_number: string;
  bank_routing_info: string;
  currency_preference: string;
  created_at: Date;
  updated_at: Date;
}

interface AuditLogRow {
  id: string;
  actor_id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | string;
  ip_address: string;
  created_at: Date;
}

interface OutboxEventRow {
  id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  published: boolean;
  published_at: Date | null;
  created_at: Date;
}

interface ProfileResponse {
  id: string;
  fullName: string;
  phone: string;
  address: string;
  city: string;
  country: string;
  bankAccountNumber: string;
  bankRoutingInfo: {
    bic: string;
    bankName: string;
  };
}

interface AgreementSignResponse {
  success: boolean;
  userStatus: string;
  signedAt: string;
}

describe('Client Onboarding & Profiles (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let clientAToken: string;
  let clientBToken: string;
  let clientAId: string;
  let clientBId: string;
  let tenantBId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();

    dataSource = app.get(DataSource);

    // Ensure core.onboarding_drafts table exists in the database
    await dataSource.query(`
      CREATE TABLE IF NOT EXISTS core.onboarding_drafts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Enable ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY so RLS is enforced even for the owner/superuser (postgres)
    await dataSource.query(
      'ALTER TABLE core.user_profiles ENABLE ROW LEVEL SECURITY',
    );
    await dataSource.query(
      'ALTER TABLE core.user_profiles FORCE ROW LEVEL SECURITY',
    );
    await dataSource.query(
      'ALTER TABLE core.onboarding_drafts ENABLE ROW LEVEL SECURITY',
    );
    await dataSource.query(
      'ALTER TABLE core.onboarding_drafts FORCE ROW LEVEL SECURITY',
    );

    // Ensure RLS isolation policy exists for core.onboarding_drafts
    await dataSource.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies 
          WHERE tablename = 'onboarding_drafts' AND policyname = 'tenant_isolation_policy'
        ) THEN
          CREATE POLICY tenant_isolation_policy ON core.onboarding_drafts
            FOR ALL
            USING (user_id IN (
              SELECT id FROM core.users WHERE tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
            ));
        END IF;
      END
      $$;
    `);

    // Clean up users and dependants
    await dataSource.query('TRUNCATE TABLE core.users CASCADE');
    await dataSource.query('TRUNCATE TABLE core.outbox_events CASCADE');
    await dataSource.query('TRUNCATE TABLE core.audit_log CASCADE');

    const server = app.getHttpServer() as unknown as Record<string, unknown>;

    // Register Client A
    const registerARes = (await request(server)
      .post('/api/auth/register')
      .send({
        email: 'client.a@titan.com',
        password: 'ClientAPassword123!',
        type: 'INDIVIDUAL',
      })
      .expect(201)) as unknown as { body: AuthResponse };

    clientAToken = registerARes.body.accessToken;
    clientAId = registerARes.body.id;

    // Register Client B
    const registerBRes = (await request(server)
      .post('/api/auth/register')
      .send({
        email: 'client.b@titan.com',
        password: 'ClientBPassword123!',
        type: 'ENTERPRISE',
      })
      .expect(201)) as unknown as { body: AuthResponse };

    clientBToken = registerBRes.body.accessToken;
    clientBId = registerBRes.body.id;

    // Fetch tenant IDs from database
    const usersB = (await dataSource.query(
      'SELECT tenant_id FROM core.users WHERE id = $1',
      [clientBId],
    )) as unknown as DBUser[];
    tenantBId = usersB[0].tenant_id;

    // Create a non-superuser role for testing RLS boundaries
    await dataSource.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'test_rls_role') THEN
          CREATE ROLE test_rls_role;
        END IF;
      END
      $$;
    `);
    await dataSource.query('GRANT USAGE ON SCHEMA core TO test_rls_role');
    await dataSource.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO test_rls_role',
    );
  }, 30000);

  afterAll(async () => {
    // Disable FORCE ROW LEVEL SECURITY on teardown
    await dataSource.query(
      'ALTER TABLE core.user_profiles NO FORCE ROW LEVEL SECURITY',
    );
    await dataSource.query(
      'ALTER TABLE core.onboarding_drafts NO FORCE ROW LEVEL SECURITY',
    );
    try {
      await dataSource.query('DROP OWNED BY test_rls_role');
      await dataSource.query('DROP ROLE IF EXISTS test_rls_role');
    } catch {
      // Ignore if role does not exist or cannot be dropped
    }
    await dataSource.query('TRUNCATE TABLE core.users CASCADE');
    await dataSource.query('TRUNCATE TABLE core.outbox_events CASCADE');
    await dataSource.query('TRUNCATE TABLE core.audit_log CASCADE');
    await app.close();
  });

  describe('Profile Retrieve before setup (GET /api/profiles/me)', () => {
    it('should return 404 for Client A who has no profile yet', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .get('/api/profiles/me')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(HttpStatus.NOT_FOUND);
    });
  });

  describe('Agreement Sign before profile setup (POST /api/profiles/sign-agreement)', () => {
    it('should reject signing with 400 Bad Request', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/profiles/sign-agreement')
        .set('Authorization', `Bearer ${clientAToken}`)
        .send({ version: 'v1.0' })
        .expect(HttpStatus.BAD_REQUEST);
    });
  });

  describe('Onboarding Drafts (POST & GET /api/profiles/draft)', () => {
    const draftPayload = {
      fullName: 'Draft Client A',
      phone: '+353879999999',
      address: 'Draft address details',
    };

    it('should allow Client A to save a draft onboarding profile', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = await request(server)
        .post('/api/profiles/draft')
        .set('Authorization', `Bearer ${clientAToken}`)
        .send({ payload: draftPayload })
        .expect(HttpStatus.OK);

      const body = response.body as { success: boolean; updatedAt: string };
      expect(body.success).toBe(true);
      expect(body).toHaveProperty('updatedAt');
    });

    it('should allow Client A to retrieve the saved draft onboarding profile', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = await request(server)
        .get('/api/profiles/draft')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as { payload: Record<string, unknown> };
      expect(body.payload).toEqual(draftPayload);
    });

    it('should return 404 for Client B who has not saved any draft', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .get('/api/profiles/draft')
        .set('Authorization', `Bearer ${clientBToken}`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should enforce database-level RLS boundary on onboarding_drafts query', async () => {
      // Simulate tenant isolation at DB layer using transaction local setting
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // Enforce Client B's tenant context
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true)`,
          [tenantBId],
        );

        // Switch to the non-superuser test role to enforce RLS
        await queryRunner.query(`SET LOCAL ROLE test_rls_role`);

        // Attempting to query Client A's draft (from Client A's tenant context) should return nothing
        const drafts = (await queryRunner.query(
          'SELECT * FROM core.onboarding_drafts WHERE user_id = $1',
          [clientAId],
        )) as unknown[];
        expect(drafts.length).toBe(0);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });
  });

  describe('Save Profile (POST /api/profiles/me)', () => {
    const profilePayloadA = {
      type: 'INDIVIDUAL',
      fullName: 'Client A Name',
      contactPerson: 'Representative A',
      phone: '+353871234567',
      address: '123 Main St, Dublin, Ireland',
      city: 'Dublin',
      country: 'IE',
      bankAccountNumber: 'IE12BOFI90000012345678',
      bankRoutingInfo: {
        bic: 'BOFIIE2D',
        bankName: 'Bank of Ireland',
      },
    };

    it('should successfully save Client A profile and transition user status to PENDING_AGREEMENT', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = await request(server)
        .post('/api/profiles/me')
        .set('Authorization', `Bearer ${clientAToken}`)
        .send(profilePayloadA)
        .expect(HttpStatus.CREATED);

      const body = response.body as ProfileResponse;
      expect(body).toHaveProperty('id');
      expect(body.fullName).toBe(profilePayloadA.fullName);
      expect(body.phone).toBe(profilePayloadA.phone);
      expect(body.address).toBe(profilePayloadA.address);
      expect(body.bankAccountNumber).toBe(profilePayloadA.bankAccountNumber);
      expect(body.bankRoutingInfo).toEqual(profilePayloadA.bankRoutingInfo);

      // Verify status in DB transitioned to PENDING_AGREEMENT
      const users = (await dataSource.query(
        'SELECT status FROM core.users WHERE id = $1',
        [clientAId],
      )) as unknown as DBUser[];
      expect(users[0].status).toBe('PENDING_AGREEMENT');
    });

    it('should delete the onboarding draft upon successful profile submit', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      // Get draft now should return 404 since profile was successfully submitted
      await request(server)
        .get('/api/profiles/draft')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should encrypt sensitive PII fields in the database', async () => {
      // Fetch directly from DB bypassing RLS (no tenant context set on the direct query client)
      const profiles = (await dataSource.query(
        'SELECT * FROM core.user_profiles WHERE user_id = $1',
        [clientAId],
      )) as unknown as RawProfileRow[];
      const rawProfile = profiles[0];

      expect(rawProfile).toBeDefined();
      expect(rawProfile.phone).not.toBe('+353871234567');
      expect(rawProfile.phone.startsWith('cipher:')).toBe(true);

      expect(rawProfile.address).not.toBe('123 Main St, Dublin, Ireland');
      expect(rawProfile.address.startsWith('cipher:')).toBe(true);

      expect(rawProfile.bank_account_number).not.toBe('IE12BOFI90000012345678');
      expect(rawProfile.bank_account_number.startsWith('cipher:')).toBe(true);

      expect(rawProfile.bank_routing_info.startsWith('cipher:')).toBe(true);
    });

    it('should transparently decrypt profile fields on fetch (GET /api/profiles/me)', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = await request(server)
        .get('/api/profiles/me')
        .set('Authorization', `Bearer ${clientAToken}`)
        .expect(HttpStatus.OK);

      const body = response.body as ProfileResponse;
      expect(body.fullName).toBe('Client A Name');
      expect(body.phone).toBe('+353871234567');
      expect(body.address).toBe('123 Main St, Dublin, Ireland');
      expect(body.bankAccountNumber).toBe('IE12BOFI90000012345678');
      expect(body.bankRoutingInfo).toEqual({
        bic: 'BOFIIE2D',
        bankName: 'Bank of Ireland',
      });
    });

    it('should enforce RLS boundaries: Client B calling GET /api/profiles/me should not see Client A profile', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      // Client B has no profile yet, should get 404 even though Client A has a profile
      await request(server)
        .get('/api/profiles/me')
        .set('Authorization', `Bearer ${clientBToken}`)
        .expect(HttpStatus.NOT_FOUND);
    });

    it('should enforce database-level RLS boundary on user_profiles query', async () => {
      // Simulate tenant isolation at DB layer using transaction local setting
      const queryRunner = dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      try {
        // Enforce Client B's tenant context
        await queryRunner.query(
          `SELECT set_config('app.current_tenant_id', $1, true)`,
          [tenantBId],
        );

        // Switch to the non-superuser test role to enforce RLS
        await queryRunner.query(`SET LOCAL ROLE test_rls_role`);

        // Attempting to query Client A's profile (from Client A's tenant context) should return nothing
        const profiles = (await queryRunner.query(
          'SELECT * FROM core.user_profiles WHERE user_id = $1',
          [clientAId],
        )) as unknown as RawProfileRow[];
        expect(profiles.length).toBe(0);
      } finally {
        await queryRunner.rollbackTransaction();
        await queryRunner.release();
      }
    });
  });

  describe('Sign Agreement (POST /api/profiles/sign-agreement)', () => {
    it('should successfully sign agreement for Client A, transit status to PENDING_INVESTMENT, and generate audit trail and outbox event', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = await request(server)
        .post('/api/profiles/sign-agreement')
        .set('Authorization', `Bearer ${clientAToken}`)
        .set('User-Agent', 'E2ETesterAgent')
        .send({ version: 'v1.0' })
        .expect(HttpStatus.OK);

      const body = response.body as AgreementSignResponse;
      expect(body.success).toBe(true);
      expect(body.userStatus).toBe('PENDING_INVESTMENT');
      expect(body).toHaveProperty('signedAt');

      // Verify status in DB transitioned to PENDING_INVESTMENT
      const users = (await dataSource.query(
        'SELECT status FROM core.users WHERE id = $1',
        [clientAId],
      )) as unknown as DBUser[];
      expect(users[0].status).toBe('PENDING_INVESTMENT');

      // Verify audit log entry
      const auditLogs = (await dataSource.query(
        'SELECT * FROM core.audit_log WHERE actor_id = $1 AND action = $2',
        [clientAId, 'SIGN_AGREEMENT'],
      )) as unknown as AuditLogRow[];
      expect(auditLogs.length).toBe(1);
      const auditData = (
        typeof auditLogs[0].after_state === 'string'
          ? JSON.parse(auditLogs[0].after_state)
          : auditLogs[0].after_state
      ) as Record<string, unknown>;
      expect(auditData.agreementVersion).toBe('v1.0');
      expect(auditData.userAgent).toBe('E2ETesterAgent');

      // Verify transactional outbox event
      const outboxEvents = (await dataSource.query(
        'SELECT * FROM core.outbox_events WHERE event_type = $1 ORDER BY created_at DESC',
        ['AGREEMENT_SIGNED'],
      )) as unknown as OutboxEventRow[];
      expect(outboxEvents.length).toBe(1);
      const outboxPayload = (
        typeof outboxEvents[0].payload === 'string'
          ? JSON.parse(outboxEvents[0].payload)
          : outboxEvents[0].payload
      ) as Record<string, unknown>;
      expect(outboxPayload.userId).toBe(clientAId);
      expect(outboxPayload.agreementVersion).toBe('v1.0');
      expect(outboxEvents[0].published).toBe(false);
    });
  });
});
