import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { UserProfile } from './entities/profile.entity';
import { OnboardingDraft } from './entities/draft.entity';
import { UsersService } from './users.service';
import { ProfilesService } from './profiles.service';
import { ProfilesController } from './profiles.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserProfile, OnboardingDraft])],
  controllers: [ProfilesController],
  providers: [UsersService, ProfilesService],
  exports: [UsersService, ProfilesService, TypeOrmModule],
})
export class UsersModule {}
