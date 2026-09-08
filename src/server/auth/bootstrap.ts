import { prisma } from "@/server/db/client";
import { hashPassword } from "./session";

/**
 * First-run state.
 *
 * With no users, the app shows a setup screen instead of a login screen. This
 * avoids shipping a default password, which is the usual way self-hosted tools
 * end up exposed.
 */
export async function needsSetup(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

export async function createOwner(input: { email: string; password: string; name?: string; timezone?: string }) {
  if (!(await needsSetup())) throw new Error("An owner account already exists.");
  if (input.password.length < 10) throw new Error("Password must be at least 10 characters.");
  return prisma.user.create({
    data: {
      email: input.email.toLowerCase().trim(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
      role: "owner",
      timezone: input.timezone ?? "UTC",
    },
  });
}
