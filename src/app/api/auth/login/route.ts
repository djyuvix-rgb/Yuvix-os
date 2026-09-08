import { NextResponse } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession, SESSION_COOKIE, verifyPassword } from "@/server/auth/session";
import { toJson } from "@/server/db/json";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase().trim() } });
  const ok = user ? await verifyPassword(body.password, user.passwordHash) : false;

  if (!user || !ok) {
    // Same message either way: never reveal whether an address exists.
    await prisma.auditLog.create({
      data: { actor: "user", action: "auth.login", ok: false, detailJson: toJson({ email: body.email }) },
    });
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const { token, expiresAt } = await createSession(user.id, request.headers.get("user-agent") ?? undefined);
  const response = NextResponse.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return response;
}
