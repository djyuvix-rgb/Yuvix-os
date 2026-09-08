import { z } from "zod";
import { defineTool } from "@/server/agent/registry";
import { prisma } from "@/server/db/client";
import { toJson } from "@/server/db/json";
import { GOAL_LEVEL, GOAL_STATUS, PROJECT_STATUS, TASK_STATUS } from "@/server/domain/constants";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const toDate = (s?: string) => (s ? new Date(`${s}T12:00:00.000Z`) : undefined);

export const workTools = [
  // ── Goals ────────────────────────────────────────────────────────────────
  defineTool({
    name: "goal_create",
    group: "goals",
    autonomy: "level1",
    description:
      "Create a goal in the hierarchy VISION → ANNUAL → QUARTERLY → MONTHLY. Always attach a lower-level goal to its parent via parentId so every task can be traced up to the vision. " +
      "Give a measurable metric and target wherever a number exists — a goal with no number cannot be reviewed.",
    schema: z.object({
      level: z.enum(GOAL_LEVEL),
      title: z.string().min(3),
      description: z.string().optional(),
      parentId: z.string().optional(),
      metric: z.string().optional().describe("e.g. monthly_listeners, releases, bookings, eur_revenue"),
      targetValue: z.number().optional(),
      currentValue: z.number().optional(),
      unit: z.string().optional(),
      startDate: dateStr.optional(),
      dueDate: dateStr.optional(),
      priority: z.number().int().min(1).max(5).optional(),
    }),
    async execute(input) {
      const goal = await prisma.goal.create({
        data: {
          ...input,
          startDate: toDate(input.startDate),
          dueDate: toDate(input.dueDate),
        },
      });
      return { id: goal.id, level: goal.level, title: goal.title };
    },
  }),

  defineTool({
    name: "goal_list",
    group: "goals",
    autonomy: "level1",
    readOnly: true,
    description: "List goals, optionally filtered by level or status, with their progress against target and their child goals.",
    schema: z.object({
      level: z.enum(GOAL_LEVEL).optional(),
      status: z.enum(GOAL_STATUS).optional(),
    }),
    async execute(input) {
      const goals = await prisma.goal.findMany({
        where: { ...(input.level ? { level: input.level } : {}), ...(input.status ? { status: input.status } : {}) },
        orderBy: [{ level: "asc" }, { priority: "asc" }],
        include: { children: { select: { id: true, title: true, level: true, status: true } }, projects: { select: { id: true, name: true, status: true } } },
      });
      return {
        count: goals.length,
        goals: goals.map((g) => ({
          id: g.id,
          level: g.level,
          title: g.title,
          status: g.status,
          metric: g.metric,
          progress: g.targetValue != null ? { current: g.currentValue ?? 0, target: g.targetValue, unit: g.unit, pct: Math.round(((g.currentValue ?? 0) / g.targetValue) * 100) } : null,
          dueDate: g.dueDate?.toISOString().slice(0, 10) ?? null,
          parentId: g.parentId,
          children: g.children,
          projects: g.projects,
        })),
      };
    },
  }),

  defineTool({
    name: "goal_update",
    group: "goals",
    autonomy: "level1",
    description: "Update a goal's progress, status, target or dates. Use this when the operator reports a new number, so reviews measure against reality.",
    schema: z.object({
      id: z.string(),
      currentValue: z.number().optional(),
      targetValue: z.number().optional(),
      status: z.enum(GOAL_STATUS).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      dueDate: dateStr.optional(),
      priority: z.number().int().min(1).max(5).optional(),
    }),
    async execute({ id, dueDate, ...rest }) {
      const goal = await prisma.goal.update({ where: { id }, data: { ...rest, dueDate: toDate(dueDate) } });
      return { id: goal.id, title: goal.title, currentValue: goal.currentValue, status: goal.status };
    },
  }),

  // ── Projects ─────────────────────────────────────────────────────────────
  defineTool({
    name: "project_create",
    group: "projects",
    autonomy: "level1",
    description:
      "Create a project — a container of related tasks that moves one goal forward (a release, a growth push, an outreach wave, a content series). Link it to a goal via goalId whenever one applies.",
    schema: z.object({
      name: z.string().min(3),
      summary: z.string().optional(),
      goalId: z.string().optional(),
      type: z.enum(["release", "content", "growth", "outreach", "business", "production", "general"]).optional(),
      status: z.enum(PROJECT_STATUS).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      startDate: dateStr.optional(),
      dueDate: dateStr.optional(),
      context: z.record(z.unknown()).optional(),
    }),
    async execute({ startDate, dueDate, context, ...rest }) {
      const project = await prisma.project.create({
        data: { ...rest, startDate: toDate(startDate), dueDate: toDate(dueDate), contextJson: toJson(context ?? {}) },
      });
      return { id: project.id, name: project.name, status: project.status };
    },
  }),

  defineTool({
    name: "project_list",
    group: "projects",
    autonomy: "level1",
    readOnly: true,
    description: "List projects with task counts and progress, so you can see what is actually in flight before proposing more work.",
    schema: z.object({ status: z.enum(PROJECT_STATUS).optional(), type: z.string().optional() }),
    async execute(input) {
      const projects = await prisma.project.findMany({
        where: { ...(input.status ? { status: input.status } : {}), ...(input.type ? { type: input.type } : {}) },
        orderBy: [{ priority: "asc" }, { dueDate: "asc" }],
        include: { tasks: { select: { status: true } }, goal: { select: { id: true, title: true, level: true } } },
      });
      return {
        count: projects.length,
        projects: projects.map((p) => {
          const done = p.tasks.filter((t) => t.status === "done").length;
          return {
            id: p.id,
            name: p.name,
            type: p.type,
            status: p.status,
            priority: p.priority,
            dueDate: p.dueDate?.toISOString().slice(0, 10) ?? null,
            goal: p.goal,
            tasks: { total: p.tasks.length, done, open: p.tasks.length - done },
          };
        }),
      };
    },
  }),

  defineTool({
    name: "project_update",
    group: "projects",
    autonomy: "level1",
    description: "Update a project's status, priority, dates or summary.",
    schema: z.object({
      id: z.string(),
      name: z.string().optional(),
      summary: z.string().optional(),
      status: z.enum(PROJECT_STATUS).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      dueDate: dateStr.optional(),
      goalId: z.string().optional(),
    }),
    async execute({ id, dueDate, ...rest }) {
      const p = await prisma.project.update({
        where: { id },
        data: { ...rest, dueDate: toDate(dueDate), completedAt: rest.status === "done" ? new Date() : undefined },
      });
      return { id: p.id, name: p.name, status: p.status };
    },
  }),

  // ── Tasks ────────────────────────────────────────────────────────────────
  defineTool({
    name: "task_create",
    group: "projects",
    autonomy: "level1",
    description:
      "Create one concrete task. A good task is a single action someone can start without deciding anything first. " +
      "ALWAYS fill `rationale` with why it matters — the daily priority view shows it, and a task nobody can justify should not exist. " +
      "Set `impact` 1–5 honestly; it drives prioritisation. Use task_create_many for a batch.",
    schema: z.object({
      title: z.string().min(3),
      details: z.string().optional(),
      projectId: z.string().optional(),
      rationale: z.string().describe("Why this matters to the goal it serves"),
      priority: z.number().int().min(1).max(5).optional(),
      impact: z.number().int().min(1).max(5).optional(),
      effortMin: z.number().int().min(5).max(2400).optional(),
      dueDate: dateStr.optional(),
      scheduledFor: dateStr.optional(),
      owner: z.enum(["user", "agent"]).optional(),
      dependsOnTaskIds: z.array(z.string()).optional(),
    }),
    async execute({ dueDate, scheduledFor, dependsOnTaskIds, ...rest }, ctx) {
      const task = await prisma.task.create({
        data: { ...rest, dueDate: toDate(dueDate), scheduledFor: toDate(scheduledFor), sourceRunId: ctx.runId },
      });
      if (dependsOnTaskIds?.length) {
        await prisma.taskDependency.createMany({
          data: dependsOnTaskIds.map((dependsOnId) => ({ taskId: task.id, dependsOnId })),
        });
      }
      return { id: task.id, title: task.title, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null };
    },
  }),

  defineTool({
    name: "task_create_many",
    group: "projects",
    autonomy: "level1",
    description:
      "Create several tasks at once — the normal way to turn a plan or campaign into executable work. Every task still needs its own rationale.",
    schema: z.object({
      projectId: z.string().optional(),
      tasks: z.array(z.object({
        title: z.string().min(3),
        details: z.string().optional(),
        rationale: z.string(),
        priority: z.number().int().min(1).max(5).optional(),
        impact: z.number().int().min(1).max(5).optional(),
        effortMin: z.number().int().min(5).max(2400).optional(),
        dueDate: dateStr.optional(),
        scheduledFor: dateStr.optional(),
      })).min(1).max(40),
    }),
    async execute(input, ctx) {
      const created = [];
      for (const t of input.tasks) {
        const task = await prisma.task.create({
          data: {
            ...t,
            projectId: input.projectId,
            dueDate: toDate(t.dueDate),
            scheduledFor: toDate(t.scheduledFor),
            sourceRunId: ctx.runId,
          },
        });
        created.push({ id: task.id, title: task.title, dueDate: task.dueDate?.toISOString().slice(0, 10) ?? null });
      }
      return { created: created.length, tasks: created };
    },
  }),

  defineTool({
    name: "task_list",
    group: "projects",
    autonomy: "level1",
    readOnly: true,
    description: "List tasks with filters. Use dueBefore='today' style ISO dates to find what is overdue or due soon.",
    schema: z.object({
      status: z.enum(TASK_STATUS).optional(),
      projectId: z.string().optional(),
      dueBefore: dateStr.optional(),
      overdueOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async execute(input) {
      const tasks = await prisma.task.findMany({
        where: {
          ...(input.status ? { status: input.status } : { status: { in: ["todo", "doing", "blocked"] } }),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.dueBefore ? { dueDate: { lte: toDate(input.dueBefore) } } : {}),
          ...(input.overdueOnly ? { dueDate: { lt: new Date() } } : {}),
        },
        orderBy: [{ dueDate: "asc" }, { priority: "asc" }],
        take: input.limit ?? 50,
        include: { project: { select: { name: true } }, dependsOn: { include: { dependsOn: { select: { id: true, title: true, status: true } } } } },
      });
      return {
        count: tasks.length,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          impact: t.impact,
          effortMin: t.effortMin,
          dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
          project: t.project?.name ?? null,
          rationale: t.rationale,
          blockedBy: t.dependsOn.filter((d) => d.dependsOn.status !== "done").map((d) => d.dependsOn.title),
        })),
      };
    },
  }),

  defineTool({
    name: "task_update",
    group: "projects",
    autonomy: "level1",
    description: "Update a task: mark it done, reschedule it, change priority, or record why it is blocked.",
    schema: z.object({
      id: z.string(),
      status: z.enum(TASK_STATUS).optional(),
      title: z.string().optional(),
      details: z.string().optional(),
      priority: z.number().int().min(1).max(5).optional(),
      impact: z.number().int().min(1).max(5).optional(),
      dueDate: dateStr.optional(),
      scheduledFor: dateStr.optional(),
      blockedReason: z.string().optional(),
    }),
    async execute({ id, dueDate, scheduledFor, ...rest }) {
      const task = await prisma.task.update({
        where: { id },
        data: {
          ...rest,
          dueDate: toDate(dueDate),
          scheduledFor: toDate(scheduledFor),
          completedAt: rest.status === "done" ? new Date() : undefined,
        },
      });
      return { id: task.id, title: task.title, status: task.status };
    },
  }),

  defineTool({
    name: "decision_record",
    group: "projects",
    autonomy: "level1",
    description:
      "Log a real decision with its options, reasoning, recommendation and uncertainty. Do this for anything the operator will later ask 'why did we do that?' about — label choice, release strategy, spend, positioning. " +
      "This is what makes the system's judgement auditable over time.",
    schema: z.object({
      question: z.string().min(5),
      context: z.string().optional(),
      options: z.array(z.object({
        label: z.string(),
        upside: z.string(),
        downside: z.string(),
        opportunityCost: z.string().optional(),
      })).min(1),
      recommendation: z.string(),
      reasoning: z.string(),
      uncertainty: z.string().describe("What could make this recommendation wrong"),
      confidence: z.number().min(0).max(1),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      reviewInDays: z.number().int().min(1).max(365).optional(),
    }),
    async execute({ options, reviewInDays, ...rest }, ctx) {
      const decision = await prisma.decision.create({
        data: {
          ...rest,
          optionsJson: toJson(options),
          runId: ctx.runId,
          reviewAt: reviewInDays ? new Date(Date.now() + reviewInDays * 86_400_000) : null,
        },
      });
      return { id: decision.id, question: decision.question, recommendation: decision.recommendation };
    },
  }),

  defineTool({
    name: "decision_list",
    group: "projects",
    autonomy: "level1",
    readOnly: true,
    description: "Retrieve past decisions and their outcomes. Call this when asked why something was chosen, or before revisiting a choice already made.",
    schema: z.object({ query: z.string().optional(), entityId: z.string().optional(), limit: z.number().int().min(1).max(50).optional() }),
    async execute(input) {
      const decisions = await prisma.decision.findMany({
        where: {
          ...(input.entityId ? { entityId: input.entityId } : {}),
          ...(input.query ? { OR: [{ question: { contains: input.query } }, { reasoning: { contains: input.query } }] } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: input.limit ?? 20,
      });
      return {
        count: decisions.length,
        decisions: decisions.map((d) => ({
          id: d.id,
          question: d.question,
          recommendation: d.recommendation,
          chosen: d.chosenOption,
          reasoning: d.reasoning,
          uncertainty: d.uncertainty,
          confidence: d.confidence,
          outcome: d.outcome,
          decidedAt: (d.decidedAt ?? d.createdAt).toISOString().slice(0, 10),
        })),
      };
    },
  }),
];
