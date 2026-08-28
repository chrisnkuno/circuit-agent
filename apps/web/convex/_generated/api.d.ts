/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentRuns from "../agentRuns.js";
import type * as approvals from "../approvals.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as channels from "../channels.js";
import type * as codingRunPlan from "../codingRunPlan.js";
import type * as connectors from "../connectors.js";
import type * as crons from "../crons.js";
import type * as devPayment from "../devPayment.js";
import type * as devTools from "../devTools.js";
import type * as dispatcher from "../dispatcher.js";
import type * as e2bWebhook from "../e2bWebhook.js";
import type * as emailActions from "../emailActions.js";
import type * as github from "../github.js";
import type * as githubModel from "../githubModel.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as googleCalendarModel from "../googleCalendarModel.js";
import type * as growth from "../growth.js";
import type * as http from "../http.js";
import type * as lib_artifactStore from "../lib/artifactStore.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_workerControl from "../lib/workerControl.js";
import type * as messages from "../messages.js";
import type * as messagesActions from "../messagesActions.js";
import type * as notificationsModel from "../notificationsModel.js";
import type * as organizations from "../organizations.js";
import type * as sandboxCleanup from "../sandboxCleanup.js";
import type * as sandboxCleanupModel from "../sandboxCleanupModel.js";
import type * as sandboxMetrics from "../sandboxMetrics.js";
import type * as sandboxPreviews from "../sandboxPreviews.js";
import type * as sandboxes from "../sandboxes.js";
import type * as scheduledRuns from "../scheduledRuns.js";
import type * as scheduledRunsModel from "../scheduledRunsModel.js";
import type * as settings from "../settings.js";
import type * as skills from "../skills.js";
import type * as tasks from "../tasks.js";
import type * as telegramActions from "../telegramActions.js";
import type * as terminalPresets from "../terminalPresets.js";
import type * as terminalPresetsActions from "../terminalPresetsActions.js";
import type * as terminalRuns from "../terminalRuns.js";
import type * as wanderEvidence from "../wanderEvidence.js";
import type * as wanderEvidenceActions from "../wanderEvidenceActions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentRuns: typeof agentRuns;
  approvals: typeof approvals;
  artifacts: typeof artifacts;
  auth: typeof auth;
  channels: typeof channels;
  codingRunPlan: typeof codingRunPlan;
  connectors: typeof connectors;
  crons: typeof crons;
  devPayment: typeof devPayment;
  devTools: typeof devTools;
  dispatcher: typeof dispatcher;
  e2bWebhook: typeof e2bWebhook;
  emailActions: typeof emailActions;
  github: typeof github;
  githubModel: typeof githubModel;
  googleCalendar: typeof googleCalendar;
  googleCalendarModel: typeof googleCalendarModel;
  growth: typeof growth;
  http: typeof http;
  "lib/artifactStore": typeof lib_artifactStore;
  "lib/authz": typeof lib_authz;
  "lib/workerControl": typeof lib_workerControl;
  messages: typeof messages;
  messagesActions: typeof messagesActions;
  notificationsModel: typeof notificationsModel;
  organizations: typeof organizations;
  sandboxCleanup: typeof sandboxCleanup;
  sandboxCleanupModel: typeof sandboxCleanupModel;
  sandboxMetrics: typeof sandboxMetrics;
  sandboxPreviews: typeof sandboxPreviews;
  sandboxes: typeof sandboxes;
  scheduledRuns: typeof scheduledRuns;
  scheduledRunsModel: typeof scheduledRunsModel;
  settings: typeof settings;
  skills: typeof skills;
  tasks: typeof tasks;
  telegramActions: typeof telegramActions;
  terminalPresets: typeof terminalPresets;
  terminalPresetsActions: typeof terminalPresetsActions;
  terminalRuns: typeof terminalRuns;
  wanderEvidence: typeof wanderEvidence;
  wanderEvidenceActions: typeof wanderEvidenceActions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
