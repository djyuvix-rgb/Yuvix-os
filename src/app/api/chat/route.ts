import { prisma } from "@/server/db/client";
import { requireUser } from "@/server/auth/session";
import { runAgent } from "@/server/agent/loop";
import { registerAllTools } from "@/server/tools";
import { errorMessage, log } from "@/server/logger";
import type { AgentEvent } from "@/server/agent/types";

export const maxDuration = 300;

/**
 * Streaming agent endpoint.
 *
 * Server-sent events carry the whole run — plan, tool calls, approval requests,
 * text — so the operator watches the agent work instead of staring at a spinner
 * for two minutes. The run itself is fully persisted, so a dropped connection
 * loses the view, never the work.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return new Response(JSON.stringify({ error: "Not authenticated" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const body = (await request.json().catch(() => ({}))) as { message?: string; conversationId?: string };
  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  registerAllTools();

  let conversationId = body.conversationId;
  if (!conversationId) {
    const conversation = await prisma.conversation.create({
      data: { userId: user.id, title: message.slice(0, 80) },
    });
    conversationId = conversation.id;
  }
  await prisma.message.create({ data: { conversationId, role: "user", content: message } });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: AgentEvent | { type: "conversation"; conversationId: string }) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true; // client went away mid-run; the run continues and is persisted
        }
      };

      send({ type: "conversation", conversationId: conversationId! });

      try {
        await runAgent(
          {
            objective: message,
            userId: user.id,
            conversationId,
            trigger: "chat",
            timezone: user.timezone,
            signal: request.signal,
          },
          send,
        );
      } catch (err) {
        log.error("chat.run.failed", { error: errorMessage(err) });
        send({ type: "error", message: errorMessage(err), recoverable: false });
      } finally {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** Conversation history for the sidebar. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversationId");

    if (conversationId) {
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      });
      if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({
        id: conversation.id,
        title: conversation.title,
        messages: conversation.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, at: m.createdAt })),
      });
    }

    const conversations = await prisma.conversation.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: { id: true, title: true, updatedAt: true },
    });
    return Response.json({ conversations });
  } catch {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }
}
