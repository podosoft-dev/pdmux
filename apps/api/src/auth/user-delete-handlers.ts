export interface DeletedUser {
  id: string;
  image?: string | null;
}

export type UserDeletedHandler = (user: DeletedUser) => Promise<void>;

const handlers = new Set<UserDeletedHandler>();

/** Register module-owned cleanup that should run after better-auth removes a user. */
export function registerUserDeletedHandler(handler: UserDeletedHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Run every cleanup without turning a completed account deletion into an error. */
export async function runUserDeletedHandlers(user: DeletedUser): Promise<void> {
  const results = await Promise.allSettled([...handlers].map((handler) => handler(user)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Run user deletion cleanup failed", {
        userId: user.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}
