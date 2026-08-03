import { Injectable } from "@nestjs/common";

export type ReadinessStatus = "up" | "down";
export type ReadinessCheck = () => Promise<void>;

@Injectable()
export class ReadinessService {
  private readonly checks = new Map<string, ReadinessCheck>();

  register(name: string, check: ReadinessCheck): () => void {
    if (this.checks.has(name)) {
      throw new Error(`Readiness check "${name}" is already registered`);
    }
    this.checks.set(name, check);
    return () => {
      this.checks.delete(name);
    };
  }

  async run(): Promise<Record<string, ReadinessStatus>> {
    const results = await Promise.all(
      [...this.checks].map(async ([name, check]): Promise<[string, ReadinessStatus]> => {
        try {
          await check();
          return [name, "up"];
        } catch {
          return [name, "down"];
        }
      }),
    );
    return Object.fromEntries(results);
  }
}
