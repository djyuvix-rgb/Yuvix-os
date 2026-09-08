import { NextResponse } from "next/server";
import { createOwner, needsSetup } from "@/server/auth/bootstrap";
import { createSession, SESSION_COOKIE } from "@/server/auth/session";
import { syncIntegrations } from "@/server/integrations/registry";
import { ensureWorkspace } from "@/server/files/workspace";
import { errorMessage } from "@/server/logger";

export async function GET() {
  return NextResponse.json({ needsSetup: await needsSetup() });
}

/** First-run: creates the owner account, the workspace tree and the integration registry. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { email?: string; password?: string; name?: string; timezone?: string };
    if (!body.email || !body.password) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });

    const user = await createOwner({
      email: body.email,
      password: body.password,
      name: body.name,
      timezone: body.timezone,
    });

    await ensureWorkspace();
    await syncIntegrations();

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
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}
