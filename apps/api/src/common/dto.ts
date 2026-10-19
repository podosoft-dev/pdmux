import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppException } from "./app-exception";

export type DtoConstructor<T extends object> = new () => T;

/**
 * Validates an HTTP body against a class-validator DTO and returns the transformed
 * instance. Unknown fields and non-object bodies are refused rather than dropped,
 * with 400 `VALIDATION_ERROR`.
 */
export function dto<T extends object>(constructor: DtoConstructor<T>, value: unknown): T {
  const instance = plainToInstance(constructor, value ?? {});
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (errors.length > 0) {
    const fields = errors.map((error) => error.property).join(", ");
    throw new AppException("VALIDATION_ERROR", `Request validation failed: ${fields}`, 400);
  }
  return instance;
}
