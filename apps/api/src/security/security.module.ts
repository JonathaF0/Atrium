import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { SecurityController, SecuritySignInController } from "./security.controller";
import { SecurityService } from "./security.service";
import { TwoFactorEnforcementGuard } from "./two-factor.guard";

@Module({
  controllers: [SecurityController, SecuritySignInController],
  providers: [
    SecurityService,
    TwoFactorEnforcementGuard,
    { provide: APP_GUARD, useExisting: TwoFactorEnforcementGuard },
  ],
  exports: [SecurityService, TwoFactorEnforcementGuard],
})
export class SecurityModule {}
