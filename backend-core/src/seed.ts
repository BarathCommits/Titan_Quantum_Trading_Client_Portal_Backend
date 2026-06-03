import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AdminsService } from './admins/admins.service';
import { AdminRole } from './admins/entities/admin.entity';
import * as bcrypt from 'bcrypt';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const adminsService = app.get(AdminsService);

  const email = process.env.SEED_ADMIN_EMAIL || 'super@titan.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'SecurePassword123!';

  console.log(`Bootstrapping first SUPER_ADMIN account: ${email}...`);

  const existing = await adminsService.findByEmail(email);
  if (existing) {
    console.log(`SUPER_ADMIN with email ${email} already exists! Skipping...`);
  } else {
    const passwordHash = await bcrypt.hash(password, 10);
    const superAdmin = await adminsService.create(
      email,
      passwordHash,
      AdminRole.SUPER_ADMIN,
    );
    console.log(`Successfully bootstrapped SUPER_ADMIN. ID: ${superAdmin.id}`);
  }

  await app.close();
}

bootstrap().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
