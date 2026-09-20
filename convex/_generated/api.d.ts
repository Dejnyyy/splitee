/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as categories from "../categories.js";
import type * as expenses from "../expenses.js";
import type * as groups from "../groups.js";
import type * as guards from "../guards.js";
import type * as http from "../http.js";
import type * as lib_debts from "../lib/debts.js";
import type * as lib_inviteCode from "../lib/inviteCode.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_period from "../lib/period.js";
import type * as lib_split from "../lib/split.js";
import type * as members from "../members.js";
import type * as settlements from "../settlements.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  categories: typeof categories;
  expenses: typeof expenses;
  groups: typeof groups;
  guards: typeof guards;
  http: typeof http;
  "lib/debts": typeof lib_debts;
  "lib/inviteCode": typeof lib_inviteCode;
  "lib/money": typeof lib_money;
  "lib/period": typeof lib_period;
  "lib/split": typeof lib_split;
  members: typeof members;
  settlements: typeof settlements;
  users: typeof users;
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

export declare const components: {};
