import { Prisma } from "@/generated/prisma";
import { errorMessage } from "@/server/logger";

/**
 * Turns a Prisma error into the message a tool caller — the model — actually
 * needs.
 *
 * Prisma's own `.message` is a multi-line diagnostic meant for a developer's
 * terminal: file paths, line numbers, a source snippet, then the real reason at
 * the bottom. Passed straight through to a tool result, that dump costs tokens,
 * leaks server file layout, and buries the one sentence worth reacting to. It
 * also does not tell the model the thing it actually needs to hear: that most
 * of these errors mean it referenced an id it never got back from a real tool
 * call — invented, stale, or a placeholder like "TBD" written while drafting
 * ahead of the previous result — which is a variant of the same "never invent
 * a fact" rule the rest of this system holds to.
 *
 * The full Prisma message still reaches the server logs and the audit trail via
 * `errorMessage()` — this function only narrows what goes back to the model.
 */
export function toolErrorMessage(err: unknown): { message: string; hint?: string } {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Field-level detail (Postgres) beats model-level detail (SQLite) beats
    // nothing — take whatever this provider actually gave us.
    const field = firstFieldName(err.meta);
    const model = firstModelName(err.meta);
    switch (err.code) {
      case "P2003":
        return {
          message: field
            ? `No record exists with the id given for "${field}".`
            : model
              ? `One of the ids given in this ${model} call does not exist.`
              : "One of the ids referenced in this call does not exist.",
          hint: "Use the id a previous tool call actually returned, or look it up with the matching *_list tool. Never pass a placeholder (e.g. \"TBD\") or a guessed id — wait for the real one before referencing it.",
        };
      case "P2025":
        return {
          message: model
            ? `No ${model} exists with that id, or it was already deleted.`
            : "No record exists with that id, or it was already deleted.",
          hint: "Confirm the id with the matching *_list or *_get tool before retrying.",
        };
      case "P2002":
        return {
          message: field
            ? `A record with that "${field}" already exists.`
            : "A record with that unique value already exists.",
          hint: "Look up the existing record instead of creating a duplicate, or update it.",
        };
      default:
        return { message: `The database rejected this operation (${err.code}).` };
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    // Genuinely a bug in a tool's Prisma call, not something the model can fix
    // by changing its arguments — the schema layer should have caught a bad
    // shape first. Keep it short; the full text is still in the server log.
    return { message: "This request could not be processed due to an internal data error." };
  }

  return { message: errorMessage(err) };
}

function firstFieldName(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  const raw = m.field_name ?? m.target;
  if (typeof raw === "string") return raw.split(/[.(]/)[0];
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

function firstModelName(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const raw = (meta as Record<string, unknown>).modelName;
  return typeof raw === "string" ? raw : undefined;
}
