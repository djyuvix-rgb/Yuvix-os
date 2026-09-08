import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { prisma } from "@/server/db/client";
import { env } from "@/server/env";
import { toJson } from "@/server/db/json";
import { log } from "@/server/logger";

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export const SESSION_COOKIE = "yuvix_session";
const SESSION_DAYS = 30;

/** scrypt with a per-user salt. No plaintext or reversible form is ever stored. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Cookies hold a random token; the database holds only its hash. */
const tokenHash = (token: string) => createHash("sha256").update(`${token}${env.authSecret}`).digest("hex");

export async function createSession(userId: string, userAgent?: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await prisma.authSession.create({
    data: { userId, tokenHash: tokenHash(token), expiresAt, userAgent: userAgent?.slice(0, 300) },
  });
  await prisma.auditLog.create({
    data: { userId, actor: "user", action: "auth.login", ok: true, detailJson: toJson({ userAgent: userAgent?.slice(0, 120) }) },
  });
  return { token, expiresAt };
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  timezone: string;
}

export async function currentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.authSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    timezone: session.user.timezone,
  };
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.authSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
  }
  store.delete(SESSION_COOKIE);
}

/**
 * Guard for every API route that touches data.
 *
 * Single-operator systems tempt you to skip auth. This one holds contracts,
 * contacts and financials, and it can send messages on the operator's behalf —
 * so every route asserts a session, and the failure mode is 401, not a default
 * user.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await currentUser();
  if (!user) {
    const error = new Error("Not authenticated");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
  return user;
}

export async function purgeExpiredSessions() {
  const { count } = await prisma.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  if (count) log.info("auth.sessions.purged", { count });
  return count;
}
