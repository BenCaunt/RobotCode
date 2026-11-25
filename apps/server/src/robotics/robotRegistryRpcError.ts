import { RobotRegistryRpcError } from "@t3tools/contracts";
import type { RobotRegistryError } from "./RobotRegistry.ts";

export const robotRegistryRpcError = (error: RobotRegistryError) =>
  new RobotRegistryRpcError({ reason: error.reason, message: error.message });
