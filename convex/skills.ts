import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { nextSkillVersion, validateSkillDraft } from "../lib/skills";

const taskKind = v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations"));

export const listForOrganization = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("skills").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").collect();
  },
});

/** Proposes a new skill version distilled from a completed, evidence-backed run. Never auto-approved. */
export const proposeFromRun = mutation({
  args: {
    organizationId: v.id("organizations"),
    sourceRunId: v.id("agentRuns"),
    slug: v.string(),
    title: v.string(),
    taskKind,
    proceduralSummary: v.string(),
    sourceObjective: v.string(),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOrganizationPermission(ctx, args.organizationId, "agent:run");
    const run = await ctx.db.get(args.sourceRunId);
    if (!run) throw new Error("Source run not found");
    const task = await ctx.db.get(run.taskId);
    if (!task || task.organizationId !== args.organizationId) throw new Error("Source run does not belong to this organization");
    if (run.status !== "completed") throw new Error("Only a completed, evidence-backed run can be distilled into a skill");

    const draft = { slug: args.slug, title: args.title, taskKind: args.taskKind, proceduralSummary: args.proceduralSummary, sourceRunId: args.sourceRunId, sourceObjective: args.sourceObjective };
    validateSkillDraft(draft);

    const existingVersions = await ctx.db.query("skills").withIndex("by_organization_slug", (q) => q.eq("organizationId", args.organizationId).eq("slug", args.slug)).collect();
    const version = nextSkillVersion(existingVersions.map((skill) => skill.version));
    const now = Date.now();
    return ctx.db.insert("skills", {
      organizationId: args.organizationId, slug: args.slug, version, title: args.title, taskKind: args.taskKind,
      proceduralSummary: args.proceduralSummary, sourceRunId: args.sourceRunId, sourceObjective: args.sourceObjective,
      status: "proposed", createdAt: now, updatedAt: now,
    });
  },
});

export const decide = mutation({
  args: { skillId: v.id("skills"), decision: v.union(v.literal("approved"), v.literal("rejected")) },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const { identity } = await requireOrganizationPermission(ctx, skill.organizationId, "skill:manage");
    if (skill.status !== "proposed") throw new Error("Only a proposed skill version can be decided");
    await ctx.db.patch(skill._id, { status: args.decision, decidedBy: identity.subject, decidedAt: Date.now(), updatedAt: Date.now() });
  },
});

export const retire = mutation({
  args: { skillId: v.id("skills") },
  handler: async (ctx, args) => {
    const skill = await ctx.db.get(args.skillId);
    if (!skill) throw new Error("Skill not found");
    const { identity } = await requireOrganizationPermission(ctx, skill.organizationId, "skill:manage");
    if (skill.status !== "approved") throw new Error("Only an approved skill can be retired");
    await ctx.db.patch(skill._id, { status: "retired", decidedBy: identity.subject, decidedAt: Date.now(), updatedAt: Date.now() });
  },
});
