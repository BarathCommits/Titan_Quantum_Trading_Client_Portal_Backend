import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { DataSource } from 'typeorm';
import { AdminRole } from '../src/admins/entities/admin.entity';
import * as bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';

interface AuthResponse {
  id: string;
  email: string;
  role?: string;
  accessToken: string;
  refreshToken: string;
  tenantId?: string;
}

interface DBUser {
  id: string;
  tenant_id: string;
  email: string;
  status: string;
}

describe('Authentication & Admin Management (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  // We will seed a default Super Admin for the E2E tests
  const superAdminEmail = 'e2e-super@titan.com';
  const superAdminPassword = 'SuperSecretE2EPass123!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();

    dataSource = app.get(DataSource);

    // Clean up users and admins tables to ensure deterministic test runs
    await dataSource.query('UPDATE core.admins SET created_by = NULL');
    await dataSource.query('TRUNCATE TABLE core.users CASCADE');
    await dataSource.query('DELETE FROM core.admins WHERE email != $1', [
      'super@titan.com',
    ]);

    // Seed the e2e super admin
    const passwordHash = await bcrypt.hash(superAdminPassword, 10);
    await dataSource.query(
      `INSERT INTO core.admins (email, password_hash, role, is_active) VALUES ($1, $2, $3, $4)`,
      [superAdminEmail, passwordHash, AdminRole.SUPER_ADMIN, true],
    );
  });

  afterAll(async () => {
    // Clean up
    await dataSource.query('UPDATE core.admins SET created_by = NULL');
    await dataSource.query('TRUNCATE TABLE core.users CASCADE');
    await dataSource.query('DELETE FROM core.admins WHERE email = $1', [
      superAdminEmail,
    ]);
    await dataSource.query('DELETE FROM core.admins WHERE email = $1', [
      'manager1@titan.com',
    ]);
    await app.close();
  });

  describe('Client Registration (POST /api/auth/register)', () => {
    const newClient = {
      email: 'client1@tenant.com',
      password: 'ClientPassword123!',
      type: 'INDIVIDUAL',
    };

    it('should register a new client with a newly generated tenant ID', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/register')
        .send(newClient)
        .expect(201)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('id');
      expect(body.email).toBe(newClient.email);
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');

      const users = (await dataSource.query(
        'SELECT * FROM core.users WHERE email = $1',
        [newClient.email],
      )) as unknown as DBUser[];
      const user = users[0];
      expect(user).toBeDefined();
      expect(user.tenant_id).toBeDefined();
    });

    it('should register a new client with a specific tenant ID', async () => {
      const specificTenantId = '22222222-2222-2222-2222-222222222222';
      const clientWithTenant = {
        email: 'client2@tenant.com',
        password: 'ClientPassword123!',
        tenantId: specificTenantId,
        type: 'ENTERPRISE',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/register')
        .send(clientWithTenant)
        .expect(201)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body.email).toBe(clientWithTenant.email);

      const users = (await dataSource.query(
        'SELECT * FROM core.users WHERE email = $1',
        [clientWithTenant.email],
      )) as unknown as DBUser[];
      const user = users[0];
      expect(user).toBeDefined();
      expect(user.tenant_id).toBe(specificTenantId);
    });

    it('should throw 409 Conflict if email is already taken', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/auth/register')
        .send(newClient)
        .expect(409);
    });
  });

  describe('User Login (POST /api/auth/login)', () => {
    it('should login client with correct credentials', async () => {
      const loginPayload = {
        email: 'client1@tenant.com',
        password: 'ClientPassword123!',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/login')
        .send(loginPayload)
        .expect(200)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      expect(body.role).toBe('CLIENT');
    });

    it('should login admin with correct credentials', async () => {
      const loginPayload = {
        email: superAdminEmail,
        password: superAdminPassword,
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/login')
        .send(loginPayload)
        .expect(200)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
      expect(body.role).toBe('SUPER_ADMIN');
    });

    it('should reject login with wrong password', async () => {
      const loginPayload = {
        email: 'client1@tenant.com',
        password: 'WrongPassword!',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/auth/login')
        .send(loginPayload)
        .expect(401);
    });

    it('should reject login with non-existent email', async () => {
      const loginPayload = {
        email: 'nobody@titan.com',
        password: 'SomePassword123!',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/auth/login')
        .send(loginPayload)
        .expect(401);
    });
  });

  describe('Admin Creation (POST /api/admins)', () => {
    let superAdminToken: string;
    let clientToken: string;

    beforeAll(async () => {
      // Login as Super Admin to get token
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const superAdminLogin = (await request(server)
        .post('/api/auth/login')
        .send({
          email: superAdminEmail,
          password: superAdminPassword,
        })) as unknown as { body: AuthResponse };
      superAdminToken = superAdminLogin.body.accessToken;

      // Login as Client to get token
      const clientLogin = (await request(server).post('/api/auth/login').send({
        email: 'client1@tenant.com',
        password: 'ClientPassword123!',
      })) as unknown as { body: AuthResponse };
      clientToken = clientLogin.body.accessToken;
    });

    it('should block admin creation without token (401)', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/admins')
        .send({
          email: 'manager1@titan.com',
          password: 'ManagerPassword123!',
          role: 'POOL_MANAGER',
        })
        .expect(401);
    });

    it('should block admin creation with client token (403)', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/admins')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          email: 'manager1@titan.com',
          password: 'ManagerPassword123!',
          role: 'POOL_MANAGER',
        })
        .expect(403);
    });

    it('should allow Super Admin to create a new Pool Manager', async () => {
      const newAdminPayload = {
        email: 'manager1@titan.com',
        password: 'ManagerPassword123!',
        role: 'POOL_MANAGER',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/admins')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(newAdminPayload)
        .expect(201)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('id');
      expect(body.email).toBe(newAdminPayload.email);
      expect(body.role).toBe(newAdminPayload.role);

      // Verify the new admin can log in successfully
      const loginResponse = (await request(server)
        .post('/api/auth/login')
        .send({
          email: newAdminPayload.email,
          password: newAdminPayload.password,
        })
        .expect(200)) as unknown as { body: AuthResponse };

      const loginBody = loginResponse.body;
      expect(loginBody.role).toBe('POOL_MANAGER');
      expect(loginBody).toHaveProperty('accessToken');
    });

    it('should throw 409 Conflict if admin email already exists', async () => {
      const duplicatePayload = {
        email: 'manager1@titan.com',
        password: 'AnotherPassword123!',
        role: 'FINANCE_APPROVER',
      };

      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/admins')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(duplicatePayload)
        .expect(409);
    });
  });

  describe('Token Refresh (POST /api/auth/refresh)', () => {
    let refreshToken: string;

    beforeAll(async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const loginResponse = (await request(server)
        .post('/api/auth/login')
        .send({
          email: superAdminEmail,
          password: superAdminPassword,
        })) as unknown as { body: AuthResponse };
      refreshToken = loginResponse.body.refreshToken;
    });

    it('should issue new access & refresh tokens when valid refresh token is passed in body', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
    });

    it('should issue new access & refresh tokens when valid refresh token is passed in cookie', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/refresh')
        .set('Cookie', [`refresh_token=${refreshToken}`])
        .expect(200)) as unknown as { body: AuthResponse };

      const body = response.body;
      expect(body).toHaveProperty('accessToken');
      expect(body).toHaveProperty('refreshToken');
    });

    it('should reject refresh request with invalid token', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      await request(server)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-refresh-token' })
        .expect(401);
    });
  });

  describe('Logout (POST /api/auth/logout)', () => {
    it('should successfully log out and clear cookies', async () => {
      const server = app.getHttpServer() as unknown as Record<string, unknown>;
      const response = (await request(server)
        .post('/api/auth/logout')
        .expect(200)) as unknown as {
        body: { success: boolean };
        headers: Record<string, string[]>;
      };

      expect(response.body).toEqual({ success: true });
      const cookies = response.headers['set-cookie'];
      expect(cookies[0]).toContain('refresh_token=;');
    });
  });
});
