#!/usr/bin/env node
/**
 * TokenLens MCP Server
 *
 * Exposes TokenLens pricing data and calc engine as MCP tools so agents
 * (Claude Code, Cursor, Windsurf, etc.) can query plan costs inline.
 *
 * Tools:
 *   compare_plans     — rank all plans by cost/1M tokens for a given model
 *   run_scenario      — calculate API vs subscription cost for a usage pattern
 *   break_even        — find the daily usage hours where API cost == plan price
 *   recommend_plan    — single best-value answer for your usage profile
 *
 * Data source (in priority order):
 *   1. TOKENLENS_DATA_URL env var  → fetches JSON from that base URL at startup
 *   2. TOKENLENS_DATA_DIR env var  → reads JSON from that local directory
 *   3. Auto-detect local path      → ../data (standalone) or ../../data (monorepo)
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Types (inlined from lib/types.ts — no runtime dep on Next.js app)
// ---------------------------------------------------------------------------

interface ModelPricing {
  input_per_1m_usd: number
  output_per_1m_usd: number
}

interface Model {
  id: string
  provider: string
  label: string
  context_window_tokens?: number | null
  pricing?: ModelPricing | null
  efficiency?: { verbosity_multiplier: number; retry_multiplier: number }
}

interface PlanLimits {
  monthly_tokens_cap?: number | null
  weekly_tokens_cap?: number | null
  daily_tokens_cap?: number | null
  usage_multiplier?: number | null
  multiplier_of_plan_id?: string | null
  fair_use?: boolean | null
}

interface Plan {
  id: string
  platform_id: string
  name: string
  price: { amount: number; currency: string; period: "monthly" | "yearly" }
  included_models: string[]
  limits: PlanLimits
  confidence: string
  last_verified: string
}

// ---------------------------------------------------------------------------
// Data loading — HTTP-first with local fallback
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

const DATA_URL = process.env.TOKENLENS_DATA_URL?.replace(/\/$/, "")
const DATA_DIR_OVERRIDE = process.env.TOKENLENS_DATA_DIR

function resolveLocalDataDir(): string {
  if (DATA_DIR_OVERRIDE) return DATA_DIR_OVERRIDE
  // standalone repo: dist/index.js → ../data
  const standalone = join(__dirname, "..", "data")
  // monorepo:        mcp/dist/index.js → ../../data
  const monorepo = join(__dirname, "..", "..", "data")
  return existsSync(standalone) ? standalone : monorepo
}

// Module-level cache — populated once before server starts
let plans: Plan[]
let models: Model[]

async function loadAllData(): Promise<void> {
  const files = ["plans", "models"] as const

  if (DATA_URL) {
    try {
      const [p, m] = await Promise.all(
        files.map((f) => fetch(`${DATA_URL}/${f}.json`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${f}.json`)
          return r.json()
        }))
      )
      plans = p as Plan[]
      models = m as Model[]
      return
    } catch (err) {
      process.stderr.write(`[tokenlens-mcp] HTTP fetch failed, falling back to local: ${err}\n`)
    }
  }

  const dir = resolveLocalDataDir()
  plans = JSON.parse(readFileSync(join(dir, "plans.json"), "utf-8")) as Plan[]
  models = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8")) as Model[]
}

// ---------------------------------------------------------------------------
// Calc engine (pure functions, mirrors lib/calc/)
// ---------------------------------------------------------------------------

function tokenCost(
  inputTokens: number,
  outputTokens: number,
  model: Model
): number | null {
  if (!model.pricing) return null
  return (
    (inputTokens / 1e6) * model.pricing.input_per_1m_usd +
    (outputTokens / 1e6) * model.pricing.output_per_1m_usd
  )
}

function costPer1MTokens(model: Model, outputRatio: number): number | null {
  if (!model.pricing) return null
  return (
    (1 - outputRatio) * model.pricing.input_per_1m_usd +
    outputRatio * model.pricing.output_per_1m_usd
  )
}

function estimateCap(
  plan: Plan,
  allPlans: Plan[],
  depth = 0
): { tokens: number | null; method: string } {
  if (depth > 3) return { tokens: null, method: "unknown" }
  const l = plan.limits
  if (l.monthly_tokens_cap) return { tokens: l.monthly_tokens_cap, method: "monthly" }
  if (l.weekly_tokens_cap) return { tokens: Math.round(l.weekly_tokens_cap * 4.33), method: "weekly" }
  if (l.daily_tokens_cap) return { tokens: Math.round(l.daily_tokens_cap * 30.4), method: "daily" }
  if (l.usage_multiplier && l.multiplier_of_plan_id) {
    const base = allPlans.find((p) => p.id === l.multiplier_of_plan_id)
    if (base) {
      const baseCap = estimateCap(base, allPlans, depth + 1)
      if (baseCap.tokens != null)
        return { tokens: Math.round(baseCap.tokens * l.usage_multiplier), method: "multiplier" }
    }
  }
  return { tokens: null, method: "unknown" }
}

function monthlyPrice(plan: Plan): number {
  return plan.price.period === "yearly" ? plan.price.amount / 12 : plan.price.amount
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "tokenlens",
  version: "0.1.0",
})

// ---------------------------------------------------------------------------
// Tool: compare_plans
// ---------------------------------------------------------------------------

server.tool(
  "compare_plans",
  "Rank all TokenLens plans by effective cost per 1M tokens. " +
  "Useful when choosing between subscriptions and API access for a given model.",
  {
    model_id: z
      .string()
      .optional()
      .describe(
        "Filter to plans that include this model (e.g. 'claude-sonnet', 'gpt-4o'). " +
        "If omitted, all plans are returned."
      ),
    output_ratio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35)
      .describe("Fraction of tokens that are output (0–1). Default 0.35."),
  },
  async ({ model_id, output_ratio = 0.35 }) => {
    const modelMap = new Map(models.map((m) => [m.id, m]))

    const rows = plans
      .filter((p) => !model_id || p.included_models.includes(model_id))
      .map((plan) => {
        const cap = estimateCap(plan, plans)
        const mo = monthlyPrice(plan)

        const pricedModel = plan.included_models
          .map((id) => modelMap.get(id))
          .find((m) => m?.pricing != null)

        const cost1M = pricedModel ? costPer1MTokens(pricedModel, output_ratio) : null

        const subCost1M =
          mo > 0 && cap.tokens ? (mo / cap.tokens) * 1_000_000 : null

        return {
          plan_id: plan.id,
          name: plan.name,
          platform_id: plan.platform_id,
          monthly_price_usd: mo,
          token_cap_monthly: cap.tokens,
          api_cost_per_1m: cost1M != null ? +cost1M.toFixed(4) : null,
          sub_effective_cost_per_1m: subCost1M != null ? +subCost1M.toFixed(4) : null,
          confidence: plan.confidence,
          last_verified: plan.last_verified,
        }
      })
      .sort((a, b) => {
        const ca = a.sub_effective_cost_per_1m ?? a.api_cost_per_1m ?? Infinity
        const cb = b.sub_effective_cost_per_1m ?? b.api_cost_per_1m ?? Infinity
        return ca - cb
      })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ plans: rows, output_ratio }, null, 2),
        },
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// Tool: run_scenario
// ---------------------------------------------------------------------------

server.tool(
  "run_scenario",
  "Calculate total monthly token usage and cost (API vs subscription) " +
  "for a given usage pattern. Returns costs for all matching plans side-by-side.",
  {
    hours_per_day: z
      .number()
      .min(0.1)
      .max(24)
      .describe("Average hours per day you use AI coding tools."),
    days_per_month: z
      .number()
      .min(1)
      .max(31)
      .optional()
      .default(22)
      .describe("Working days per month. Default 22."),
    tokens_per_hour: z
      .number()
      .min(1000)
      .optional()
      .default(800000)
      .describe("Tokens consumed per hour of active use. Default 800,000."),
    output_ratio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35)
      .describe("Fraction of tokens that are output. Default 0.35."),
    model_id: z
      .string()
      .optional()
      .default("claude-sonnet")
      .describe("Model to price API usage against. Default 'claude-sonnet'."),
  },
  async ({ hours_per_day, days_per_month = 22, tokens_per_hour = 800000, output_ratio = 0.35, model_id = "claude-sonnet" }) => {
    const model = models.find((m) => m.id === model_id)
    if (!model) {
      return {
        content: [{ type: "text", text: `Model '${model_id}' not found. Available: ${models.map((m) => m.id).join(", ")}` }],
        isError: true,
      }
    }

    const totalTokens = hours_per_day * days_per_month * tokens_per_hour
    const outputTokens = Math.round(totalTokens * output_ratio)
    const inputTokens = totalTokens - outputTokens
    const apiCost = tokenCost(inputTokens, outputTokens, model)

    const planResults = plans
      .filter((p) => p.included_models.includes(model_id))
      .map((plan) => {
        const cap = estimateCap(plan, plans)
        const mo = monthlyPrice(plan)
        const withinCap = cap.tokens == null || totalTokens <= cap.tokens
        return {
          plan_id: plan.id,
          name: plan.name,
          monthly_price_usd: mo,
          token_cap_monthly: cap.tokens,
          tokens_needed: Math.round(totalTokens),
          within_cap: withinCap,
          verdict: mo === 0
            ? "pay-per-token"
            : withinCap
              ? apiCost != null && mo < apiCost
                ? "subscription_cheaper"
                : "api_cheaper"
              : "exceeds_cap",
        }
      })

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              inputs: { hours_per_day, days_per_month, tokens_per_hour, output_ratio, model_id },
              usage: {
                total_tokens: Math.round(totalTokens),
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                api_cost_usd: apiCost != null ? +apiCost.toFixed(4) : null,
              },
              plans: planResults,
            },
            null,
            2
          ),
        },
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// Tool: break_even
// ---------------------------------------------------------------------------

server.tool(
  "break_even",
  "Find the daily usage hours at which API cost equals a subscription price. " +
  "Below this threshold, the API is cheaper; above it, the subscription wins.",
  {
    plan_id: z
      .string()
      .describe("The plan to find break-even for (e.g. 'cursor-pro', 'claude-code-pro')."),
    model_id: z
      .string()
      .optional()
      .default("claude-sonnet")
      .describe("Model to price API usage against. Default 'claude-sonnet'."),
    days_per_month: z
      .number()
      .min(1)
      .max(31)
      .optional()
      .default(22)
      .describe("Working days per month. Default 22."),
    tokens_per_hour: z
      .number()
      .min(1000)
      .optional()
      .default(800000)
      .describe("Tokens consumed per hour of active use. Default 800,000."),
    output_ratio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35)
      .describe("Fraction of tokens that are output. Default 0.35."),
  },
  async ({ plan_id, model_id = "claude-sonnet", days_per_month = 22, tokens_per_hour = 800000, output_ratio = 0.35 }) => {
    const plan = plans.find((p) => p.id === plan_id)
    if (!plan) {
      return {
        content: [{ type: "text", text: `Plan '${plan_id}' not found. Available: ${plans.map((p) => p.id).join(", ")}` }],
        isError: true,
      }
    }

    const model = models.find((m) => m.id === model_id)
    if (!model || !model.pricing) {
      return {
        content: [{ type: "text", text: `Model '${model_id}' not found or has no pricing data.` }],
        isError: true,
      }
    }

    const mo = monthlyPrice(plan)
    if (mo === 0) {
      return {
        content: [{ type: "text", text: `Plan '${plan.name}' is pay-per-token (no fixed price) — break-even doesn't apply.` }],
      }
    }

    const costPerToken =
      ((1 - output_ratio) * model.pricing.input_per_1m_usd +
        output_ratio * model.pricing.output_per_1m_usd) /
      1_000_000

    const breakEvenHours = mo / (days_per_month * tokens_per_hour * costPerToken)

    const cap = estimateCap(plan, plans)
    const capHours = cap.tokens ? cap.tokens / (days_per_month * tokens_per_hour) : null

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              plan: plan.name,
              model: model.label,
              monthly_price_usd: mo,
              break_even_hours_per_day: +breakEvenHours.toFixed(2),
              interpretation:
                breakEvenHours < 0.5
                  ? "Subscription is almost always cheaper — API cost exceeds plan price at very low usage."
                  : breakEvenHours > 8
                    ? "API is almost always cheaper — you'd need to use it more than a full workday to justify the subscription."
                    : `At ${breakEvenHours.toFixed(1)}h/day the costs are equal. Below that, use the API; above that, the subscription saves money.`,
              token_cap_monthly: cap.tokens,
              cap_reached_at_hours_per_day: capHours ? +capHours.toFixed(2) : null,
            },
            null,
            2
          ),
        },
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// Tool: recommend_plan
// ---------------------------------------------------------------------------

server.tool(
  "recommend_plan",
  "Get a single best-value plan recommendation for your usage profile. " +
  "Considers whether a subscription or API access is cheaper, and whether token caps are sufficient.",
  {
    hours_per_day: z
      .number()
      .min(0.1)
      .max(24)
      .describe("Average hours per day you use AI coding tools."),
    days_per_month: z
      .number()
      .min(1)
      .max(31)
      .optional()
      .default(22)
      .describe("Working days per month. Default 22."),
    tokens_per_hour: z
      .number()
      .min(1000)
      .optional()
      .default(800000)
      .describe("Tokens per hour. Default 800,000."),
    output_ratio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35)
      .describe("Fraction of output tokens. Default 0.35."),
    model_id: z
      .string()
      .optional()
      .default("claude-sonnet")
      .describe("Primary model you use. Default 'claude-sonnet'."),
    max_budget_usd: z
      .number()
      .optional()
      .describe("Maximum monthly budget in USD. If set, excludes plans above this price."),
  },
  async ({ hours_per_day, days_per_month = 22, tokens_per_hour = 800000, output_ratio = 0.35, model_id = "claude-sonnet", max_budget_usd }) => {
    const model = models.find((m) => m.id === model_id)
    if (!model) {
      return {
        content: [{ type: "text", text: `Model '${model_id}' not found.` }],
        isError: true,
      }
    }

    const totalTokens = hours_per_day * days_per_month * tokens_per_hour
    const outputTokens = Math.round(totalTokens * output_ratio)
    const inputTokens = totalTokens - outputTokens
    const apiCost = tokenCost(inputTokens, outputTokens, model) ?? Infinity

    const candidates = plans
      .filter((p) => p.included_models.includes(model_id))
      .filter((p) => {
        const mo = monthlyPrice(p)
        return max_budget_usd == null || mo <= max_budget_usd
      })
      .map((plan) => {
        const cap = estimateCap(plan, plans)
        const mo = monthlyPrice(plan)
        const withinCap = cap.tokens == null || totalTokens <= cap.tokens
        const effectiveCost = mo === 0 ? apiCost : withinCap ? mo : Infinity
        return { plan, mo, cap, withinCap, effectiveCost }
      })
      .filter((c) => c.effectiveCost < Infinity)
      .sort((a, b) => a.effectiveCost - b.effectiveCost)

    if (candidates.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No suitable plans found for your usage profile. Consider increasing your budget or reducing usage.",
          },
        ],
      }
    }

    const best = candidates[0]
    const runner_up = candidates[1]

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              recommendation: {
                plan_id: best.plan.id,
                name: best.plan.name,
                monthly_price_usd: best.mo,
                effective_monthly_cost_usd: +best.effectiveCost.toFixed(2),
                token_cap_monthly: best.cap.tokens,
                tokens_needed: Math.round(totalTokens),
                within_cap: best.withinCap,
                confidence: best.plan.confidence,
              },
              api_only_cost_usd: apiCost === Infinity ? null : +apiCost.toFixed(2),
              savings_vs_api_usd:
                best.mo > 0 && apiCost < Infinity
                  ? +(apiCost - best.mo).toFixed(2)
                  : null,
              runner_up: runner_up
                ? {
                    plan_id: runner_up.plan.id,
                    name: runner_up.plan.name,
                    monthly_price_usd: runner_up.mo,
                    effective_monthly_cost_usd: +runner_up.effectiveCost.toFixed(2),
                  }
                : null,
              inputs: { hours_per_day, days_per_month, tokens_per_hour, output_ratio, model_id, max_budget_usd },
            },
            null,
            2
          ),
        },
      ],
    }
  }
)

// ---------------------------------------------------------------------------
// Start — load data first, then connect transport
// ---------------------------------------------------------------------------

await loadAllData()
const transport = new StdioServerTransport()
await server.connect(transport)
