import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { parseList, toJson } from "@/server/db/json";
import { CRM_ACTIVE_STATUSES, CRM_STATUS, OUTREACH_PURPOSES } from "@/server/domain/constants";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s?: string) => (s ? new Date(`${s}T12:00:00.000Z`) : undefined);

export const crmTools = [
  defineTool({
    name: "contact_upsert",
    group: "crm",
    autonomy: "level1",
    description:
      "Create or update a person in the industry CRM: label manager, A&R, DJ, promoter, booker, journalist, curator, collaborator. " +
      "Record contact details only from sources you verified. Always set nextAction and nextActionAt for anyone in an active pipeline stage — that is what drives the follow-up queue.",
    schema: z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      role: z.string().optional(),
      company: z.string().optional(),
      labelId: z.string().optional(),
      email: z.string().email().optional(),
      instagram: z.string().optional(),
      soundcloud: z.string().optional(),
      website: z.string().url().optional(),
      country: z.string().optional(),
      city: z.string().optional(),
      relationship: z.enum(["cold", "warm", "active", "dormant"]).optional(),
      status: z.enum(CRM_STATUS).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      nextAction: z.string().optional(),
      nextActionAt: dateStr.optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sources: z.array(z.object({ url: z.string(), title: z.string().optional() })).optional(),
    }),
    async execute({ id, tags, sources, nextActionAt, ...rest }) {
      const data = {
        ...rest,
        ...(tags ? { tagsJson: toJson(tags) } : {}),
        ...(sources ? { sourcesJson: toJson(sources) } : {}),
        ...(nextActionAt ? { nextActionAt: toDate(nextActionAt) } : {}),
      };
      const contact = id
        ? await prisma.contact.update({ where: { id }, data })
        : await prisma.contact.create({ data });
      return { id: contact.id, name: contact.name, status: contact.status };
    },
  }),

  defineTool({
    name: "contact_list",
    group: "crm",
    autonomy: "level1",
    readOnly: true,
    description: "Search and list contacts with their pipeline status, last contact date and pending next action.",
    schema: z.object({
      query: z.string().optional(),
      status: z.enum(CRM_STATUS).optional(),
      role: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input) {
      const contacts = await prisma.contact.findMany({
        where: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.role ? { role: { contains: input.role } } : {}),
          ...(input.query
            ? { OR: [{ name: { contains: input.query } }, { company: { contains: input.query } }, { notes: { contains: input.query } }] }
            : {}),
        },
        orderBy: [{ priority: "asc" }, { nextActionAt: "asc" }],
        take: input.limit ?? 40,
        include: { interactions: { orderBy: { occurredAt: "desc" }, take: 2 }, label: { select: { name: true } } },
      });
      return {
        count: contacts.length,
        contacts: contacts.map((c) => ({
          id: c.id,
          name: c.name,
          role: c.role,
          company: c.company ?? c.label?.name ?? null,
          email: c.email,
          instagram: c.instagram,
          relationship: c.relationship,
          status: c.status,
          priority: c.priority,
          lastContactAt: c.lastContactAt?.toISOString().slice(0, 10) ?? null,
          nextAction: c.nextAction,
          nextActionAt: c.nextActionAt?.toISOString().slice(0, 10) ?? null,
          tags: parseList(c.tagsJson),
          notes: c.notes,
          recent: c.interactions.map((i) => ({ direction: i.direction, channel: i.channel, subject: i.subject, outcome: i.outcome, at: i.occurredAt.toISOString().slice(0, 10) })),
        })),
      };
    },
  }),

  defineTool({
    name: "crm_follow_up_queue",
    group: "crm",
    autonomy: "level1",
    readOnly: true,
    description:
      "The answer to 'who should I contact this week'. Returns everyone due for action — overdue next-actions, contacted-but-silent, and warm relationships going cold — with the reason, prior history and a suggested priority. " +
      "It never returns people who were contacted too recently, so the system does not push you into spamming anyone.",
    schema: z.object({
      withinDays: z.number().int().min(1).max(60).optional().describe("Look ahead this many days (default 7)"),
      minSilentDays: z.number().int().min(1).max(120).optional().describe("Don't resurface anyone contacted more recently than this (default 10)"),
    }),
    async execute(input) {
      const horizon = new Date(Date.now() + (input.withinDays ?? 7) * 86_400_000);
      const quietAfter = new Date(Date.now() - (input.minSilentDays ?? 10) * 86_400_000);

      const [dueContacts, silentContacts, dueLabels] = await Promise.all([
        prisma.contact.findMany({
          where: { nextActionAt: { lte: horizon }, status: { notIn: ["rejected", "inactive", "signed"] } },
          orderBy: [{ nextActionAt: "asc" }, { priority: "asc" }],
          include: { interactions: { orderBy: { occurredAt: "desc" }, take: 1 } },
          take: 25,
        }),
        prisma.contact.findMany({
          where: {
            status: { in: ["contacted", "replied", "interested", "negotiating"] },
            OR: [{ lastContactAt: { lte: quietAfter } }, { lastContactAt: null }],
          },
          orderBy: { lastContactAt: "asc" },
          include: { interactions: { orderBy: { occurredAt: "desc" }, take: 1 } },
          take: 25,
        }),
        prisma.label.findMany({
          where: { nextActionAt: { lte: horizon }, status: { notIn: ["rejected", "inactive", "signed"] } },
          orderBy: { nextActionAt: "asc" },
          take: 15,
        }),
      ]);

      const seen = new Set<string>();
      const queue: unknown[] = [];

      const push = (c: (typeof dueContacts)[number], reason: string) => {
        if (seen.has(c.id)) return;
        // Respect the quiet period even for scheduled actions.
        if (c.lastContactAt && c.lastContactAt > quietAfter) return;
        seen.add(c.id);
        const daysSince = c.lastContactAt
          ? Math.round((Date.now() - c.lastContactAt.getTime()) / 86_400_000)
          : null;
        queue.push({
          type: "contact",
          id: c.id,
          name: c.name,
          role: c.role,
          company: c.company,
          status: c.status,
          reason,
          daysSinceContact: daysSince,
          lastInteraction: c.interactions[0]
            ? { channel: c.interactions[0].channel, subject: c.interactions[0].subject, outcome: c.interactions[0].outcome }
            : null,
          suggestedAction: c.nextAction ?? "Follow up on the last conversation",
          priority: c.priority,
          channel: c.email ? "email" : c.instagram ? "instagram" : "unknown",
        });
      };

      for (const c of dueContacts) push(c, c.nextActionAt && c.nextActionAt < new Date() ? "Next action is overdue" : "Next action is due");
      for (const c of silentContacts) push(c, `No contact in ${input.minSilentDays ?? 10}+ days while still in an active stage`);

      for (const l of dueLabels) {
        queue.push({
          type: "label",
          id: l.id,
          name: l.name,
          status: l.status,
          reason: l.nextActionAt && l.nextActionAt < new Date() ? "Label next action is overdue" : "Label next action is due",
          suggestedAction: l.nextAction ?? "Follow up on the submission",
          fitScore: l.fitScore,
          submission: { method: l.submissionMethod, email: l.submissionEmail, url: l.submissionUrl },
        });
      }

      return {
        count: queue.length,
        quietPeriodDays: input.minSilentDays ?? 10,
        queue,
        note: queue.length
          ? "Draft personalised messages with outreach_draft. Never send the same text to multiple people."
          : "Nobody is due. Do not manufacture reasons to contact people.",
      };
    },
  }),

  defineTool({
    name: "interaction_log",
    group: "crm",
    autonomy: "level1",
    description:
      "Record a real interaction that happened with a contact or label (sent, received, call, meeting) and its outcome. Updates lastContactAt automatically. " +
      "Only log things that actually happened — this table is the evidence base for follow-up timing.",
    schema: z.object({
      contactId: z.string().optional(),
      labelId: z.string().optional(),
      direction: z.enum(["outbound", "inbound"]),
      channel: z.enum(["email", "instagram", "soundcloud", "whatsapp", "call", "in_person", "other"]),
      subject: z.string().optional(),
      body: z.string().optional(),
      outcome: z.enum(["no_reply", "replied", "positive", "negative", "meeting", "deal"]).optional(),
      occurredAt: dateStr.optional(),
      nextAction: z.string().optional(),
      nextActionAt: dateStr.optional(),
      newStatus: z.enum(CRM_STATUS).optional(),
    }),
    async execute({ nextAction, nextActionAt, newStatus, occurredAt, ...rest }) {
      if (!rest.contactId && !rest.labelId) return { error: "Provide contactId or labelId." };
      const when = toDate(occurredAt) ?? new Date();
      const interaction = await prisma.interaction.create({ data: { ...rest, occurredAt: when } });

      const update = {
        lastContactAt: when,
        ...(nextAction ? { nextAction } : {}),
        ...(nextActionAt ? { nextActionAt: toDate(nextActionAt) } : {}),
        ...(newStatus ? { status: newStatus } : {}),
      };
      if (rest.contactId) await prisma.contact.update({ where: { id: rest.contactId }, data: update });
      if (rest.labelId) await prisma.label.update({ where: { id: rest.labelId }, data: update });

      return { id: interaction.id, logged: true, nextAction: nextAction ?? null };
    },
  }),

  defineTool({
    name: "outreach_draft",
    group: "crm",
    autonomy: "level1",
    description:
      "Write a personalised outreach message and save it as a draft. This does NOT send anything. " +
      "Before drafting, read the contact's history and the artist profile so the message references something specific and real about the recipient. " +
      "Generic templated pitches are worse than no pitch — if you have nothing specific to say about them, research first or say so.",
    schema: z.object({
      contactId: z.string().optional(),
      targetName: z.string(),
      channel: z.enum(["email", "instagram", "soundcloud", "whatsapp", "other"]),
      purpose: z.enum(OUTREACH_PURPOSES),
      subject: z.string().optional(),
      body: z.string().min(20),
      releaseId: z.string().optional(),
      followUpInDays: z.number().int().min(1).max(90).optional(),
      personalisationBasis: z.string().describe("The specific, verified thing about this recipient the message references"),
    }),
    async execute({ followUpInDays, personalisationBasis, ...rest }) {
      const outreach = await prisma.outreach.create({
        data: {
          ...rest,
          status: "draft",
          followUpAt: followUpInDays ? new Date(Date.now() + followUpInDays * 86_400_000) : null,
        },
      });
      return {
        id: outreach.id,
        status: "draft",
        personalisationBasis,
        note: "Saved as a draft. Sending is a Level 2 action — call outreach_send to request approval, or the operator can send it themselves from the Contacts panel.",
      };
    },
  }),

  defineTool({
    name: "outreach_send",
    group: "crm",
    autonomy: "level2",
    description:
      "Request approval to send a saved outreach draft. Approval creates the record that the message was authorised; the actual delivery happens through whichever channel integration is connected, or by the operator if none is. " +
      "Never claim a message was delivered unless this tool returned a sent result.",
    schema: z.object({
      outreachId: z.string(),
      confirmChannel: z.enum(["email", "instagram", "soundcloud", "whatsapp", "other"]),
    }),
    async preview(input) {
      const draft = await prisma.outreach.findUnique({ where: { id: input.outreachId }, include: { contact: true } });
      if (!draft) return { title: "Send outreach", description: "Draft not found.", details: [] };
      return {
        title: `Send ${draft.purpose.replace("_", " ")} to ${draft.targetName}`,
        description: `A real message to a real person via ${input.confirmChannel}. This cannot be unsent.`,
        details: [
          `To: ${draft.targetName}${draft.contact?.email ? ` <${draft.contact.email}>` : ""}`,
          `Channel: ${input.confirmChannel}`,
          `Subject: ${draft.subject ?? "(none)"}`,
          "---",
          draft.body.slice(0, 1500),
        ],
        riskNotes: "Check the recipient's submission policy before sending a demo. A rejected or annoyed contact is expensive to recover.",
      };
    },
    async execute(input) {
      const draft = await prisma.outreach.findUnique({ where: { id: input.outreachId } });
      if (!draft) return { error: "Draft not found." };

      // Delivery requires a connected channel integration. Approval authorises
      // the send; it does not conjure a transport that isn't configured.
      const integration = await prisma.integration.findFirst({
        where: { key: input.confirmChannel, status: "configured" },
      });

      if (!integration) {
        await prisma.outreach.update({
          where: { id: draft.id },
          data: { status: "approved", scheduledFor: new Date() },
        });
        return {
          sent: false,
          status: "approved_awaiting_manual_send",
          message:
            `Approved, but no ${input.confirmChannel} integration is connected, so YUVIX OS cannot deliver it. ` +
            "The draft is marked approved — send it yourself and then log it with interaction_log.",
          body: draft.body,
          subject: draft.subject,
        };
      }

      await prisma.outreach.update({ where: { id: draft.id }, data: { status: "sent", sentAt: new Date() } });
      if (draft.contactId) {
        await prisma.interaction.create({
          data: {
            contactId: draft.contactId,
            direction: "outbound",
            channel: input.confirmChannel,
            subject: draft.subject,
            body: draft.body,
            outcome: "no_reply",
          },
        });
        await prisma.contact.update({
          where: { id: draft.contactId },
          data: { lastContactAt: new Date(), status: "contacted" },
        });
      }
      return { sent: true, outreachId: draft.id, channel: input.confirmChannel };
    },
  }),

  defineTool({
    name: "outreach_list",
    group: "crm",
    autonomy: "level1",
    readOnly: true,
    description: "List outreach drafts and sent messages, including which are awaiting approval and which need a follow-up.",
    schema: z.object({ status: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
    async execute(input) {
      const items = await prisma.outreach.findMany({
        where: input.status ? { status: input.status } : {},
        orderBy: { createdAt: "desc" },
        take: input.limit ?? 25,
      });
      return {
        count: items.length,
        outreach: items.map((o) => ({
          id: o.id,
          target: o.targetName,
          purpose: o.purpose,
          channel: o.channel,
          status: o.status,
          subject: o.subject,
          preview: o.body.slice(0, 200),
          sentAt: o.sentAt?.toISOString().slice(0, 10) ?? null,
          followUpAt: o.followUpAt?.toISOString().slice(0, 10) ?? null,
        })),
      };
    },
  }),

  defineTool({
    name: "contract_sign",
    group: "crm",
    autonomy: "level3",
    forbiddenReason:
      "Signing or accepting contract terms is a legal commitment that binds the operator personally. YUVIX OS can read, summarise, flag risky clauses and draft questions for a lawyer — it can never agree to anything.",
    description:
      "[LEVEL 3 — cannot be executed] Represents signing a contract or accepting legal terms. Exists so the boundary is explicit: read and analyse contracts, then hand the decision to the operator.",
    schema: z.object({ documentPath: z.string(), party: z.string() }),
    async execute() {
      throw new Error("Level 3 actions have no execution path.");
    },
  }),

  defineTool({
    name: "money_transfer",
    group: "finance",
    autonomy: "level3",
    forbiddenReason:
      "Moving money is irreversible and outside what an agent should ever do unattended. YUVIX OS can budget, forecast, compare costs and prepare payment details — the operator makes every payment.",
    description: "[LEVEL 3 — cannot be executed] Represents transferring money or making a payment.",
    schema: z.object({ amountEur: z.number(), recipient: z.string(), purpose: z.string() }),
    async execute() {
      throw new Error("Level 3 actions have no execution path.");
    },
  }),
];

export const CRM_ACTIVE = CRM_ACTIVE_STATUSES;
