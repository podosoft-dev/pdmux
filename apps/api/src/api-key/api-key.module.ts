import { Module } from "@nestjs/common";
import { MachineController } from "../machine/machine.controller";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeyVerifier } from "./api-key-verifier";

@Module({
  controllers: [MachineController],
  providers: [ApiKeyGuard, ApiKeyVerifier],
  exports: [ApiKeyVerifier],
})
export class ApiKeyModule {}
