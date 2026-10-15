// Better Auth validates the database schema when an instance starts, and fails
// authentication requests while the schema does not match. Servers keep that check.
// The migration runner builds an instance only to read its options, before the
// schema it is about to change exists or matches, so it opts out for its process.
let validateSchema = true;

export function skipAuthSchemaValidation(): void {
  validateSchema = false;
}

export function authSchemaValidation(): boolean {
  return validateSchema;
}
