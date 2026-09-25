import type { APIRequestContext, APIResponse } from "@playwright/test";

/** The shared E2E browser and API client can briefly exhaust nginx's
 * per-IP burst allowance. Only its explicit 429 is retried. */
export async function requestWithRateLimit(
  request: APIRequestContext,
  path: string,
  options: { method?: string; data?: Record<string, unknown>; params?: Record<string, number | string> } = {},
): Promise<APIResponse> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await request.fetch(path, options);
    if (response.status() !== 429) return response;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${path} stayed rate-limited`);
}

/** Thin wrapper over the real HTTP API (proxied at /api by nginx, same as
 * the frontend uses) — fast, reliable fixture setup so each spec can drive
 * the actual UI against known data instead of guessing at pre-existing
 * account/category IDs. */

export async function getDefaultAccountId(request: APIRequestContext): Promise<number> {
  const resp = await request.get("/api/accounts");
  const accounts = await resp.json();
  return accounts[0].id;
}

export async function getCategoryId(request: APIRequestContext, name: string): Promise<number> {
  const resp = await request.get("/api/categories");
  const categories = await resp.json();
  const match = categories.find((c: { name: string }) => c.name === name);
  if (!match) throw new Error(`category "${name}" not found`);
  return match.id;
}

export interface TransactionInput {
  account_id: number;
  category_id?: number;
  type: "income" | "expense" | "transfer";
  amount: string;
  description: string;
  date: string; // YYYY-MM-DD
}

export async function createTransaction(request: APIRequestContext, input: TransactionInput): Promise<void> {
  const resp = await request.post("/api/transactions", { data: input });
  if (!resp.ok()) {
    throw new Error(`failed to create transaction: ${resp.status()} ${await resp.text()}`);
  }
}
