/**
 * Runtime stub for `@thallesp/nestjs-better-auth` used by jest only (wired through
 * `moduleNameMapper` in the api package.json).
 *
 * WHY: that package ships ESM only, and these unit tests run in jest's CommonJS
 * runtime — importing a controller (for the audit-coverage check) would explode on
 * its `import` syntax before a single assertion ran. Only the decorators are
 * needed at runtime here; the real types still come from the real package, because
 * TypeScript resolves types independently of this mapping.
 */

type Decorator = (...args: unknown[]) => void;

const noopDecorator: Decorator = () => undefined;

export const Session = (): Decorator => noopDecorator;
export const Public = (): Decorator => noopDecorator;
export const OptionalAuth = (): Decorator => noopDecorator;
export const AllowAnonymous = (): Decorator => noopDecorator;

export class AuthGuard {
  canActivate(): boolean {
    return true;
  }
}

export const AuthModule = {
  forRoot: (): Record<string, unknown> => ({ module: class StubAuthModule {} }),
};
