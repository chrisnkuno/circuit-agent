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
import type * as auth from "../auth.js";
import type * as connectors from "../connectors.js";
import type * as crons from "../crons.js";
import type * as devTools from "../devTools.js";
import type * as dispatcher from "../dispatcher.js";
import type * as github from "../github.js";
import type * as githubModel from "../githubModel.js";
import type * as googleCalendar from "../googleCalendar.js";
import type * as googleCalendarModel from "../googleCalendarModel.js";
import type * as http from "../http.js";
import type * as lib_artifactStore from "../lib/artifactStore.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_workerControl from "../lib/workerControl.js";
import type * as organizations from "../organizations.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentRuns: typeof agentRuns;
  approvals: typeof approvals;
  auth: typeof auth;
  connectors: typeof connectors;
  crons: typeof crons;
  devTools: typeof devTools;
  dispatcher: typeof dispatcher;
  github: typeof github;
  githubModel: typeof githubModel;
  googleCalendar: typeof googleCalendar;
  googleCalendarModel: typeof googleCalendarModel;
  http: typeof http;
  "lib/artifactStore": typeof lib_artifactStore;
  "lib/authz": typeof lib_authz;
  "lib/workerControl": typeof lib_workerControl;
  organizations: typeof organizations;
  tasks: typeof tasks;
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
