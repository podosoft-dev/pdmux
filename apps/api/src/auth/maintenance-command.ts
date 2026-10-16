// Imported first by maintenance commands, before ./auth creates the Better Auth
// instance and ./db opens its pool.
import { startMaintenanceCommand } from "./maintenance";

startMaintenanceCommand();
