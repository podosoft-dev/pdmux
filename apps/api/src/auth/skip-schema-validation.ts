// Imported first by the migration runner, before ./auth creates the Better Auth
// instance whose startup check would report the schema those migrations change.
import { skipAuthSchemaValidation } from "./schema-validation";

skipAuthSchemaValidation();
