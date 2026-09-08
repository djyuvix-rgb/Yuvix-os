import { NextResponse } from "next/server";
import { errorMessage, log } from "@/server/logger";
import { requireUser, type CurrentUser } from "@/server/auth/session";

/**
 * Route wrapper: enforces authentication, converts thrown errors into clean JSON
 * responses, and keeps stack traces server-side.
 */
export function authed<T>(handler: (user: CurrentUser, request: Request) => Promise<T>) {
  return async (request: Request) => {
    try {
      const user = await requireUser();
      const data = await handler(user, request);
      return NextResponse.json(data);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      if (status !== 401) log.error("api.error", { path: new URL(request.url).pathname, error: errorMessage(err) });
      return NextResponse.json(
        { error: status === 401 ? "Not authenticated" : errorMessage(err) },
        { status },
      );
    }
  };
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    const error = new Error("Request body must be valid JSON");
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

export function badRequest(message: string): never {
  const error = new Error(message);
  (error as Error & { status?: number }).status = 400;
  throw error;
}
