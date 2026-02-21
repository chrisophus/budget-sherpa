# CLAUDE.md — Budget Sherpa

This file provides guidance for AI assistants (Claude and others) working in this repository.

---

## Project Overview

**Budget Sherpa** is a CLI tool that imports QFX/OFX bank transaction files into [Actual Budget](https://actualbudget.org/). It uses an LLM (Anthropic Claude or OpenAI) to semi-automate the tedious work of cleaning payee names, assigning categories, tagging transactions, and creating reusable rules — while keeping the human in control through an interactive vetting workflow.

---

## Development Commands

```bash
# Development (run TypeScript directly via tsx)
npm run dev -- --dir /path/to/qfx-files

# Build (compile TypeScript → dist/)
npm run build

# Run compiled binary
npm start -- --dir /path/to/qfx-files

# Run all tests (single pass)
npm test

# Run tests in watch mode
npm run test:watch
```

**CLI flags supported by the tool:**
- `--dir <path>` — directory containing `.qfx` / `.QFX` files (required)
- `--dry-run` — parse and vet transactions but skip all writes to Actual Budget
- `--import` — also import transactions after rule creation (bare payload; rules do the transformation)
- `--skip-transfers` — skip transfer-detection when used with `--import`

---

## Repository Structure

```
budget-sherpa/
├── src/
│   ├── index.ts              # Entry point — orchestrates the full import session
│   ├── types.ts              # Shared TypeScript interfaces (see below)
│   ├── actual/
│   │   └── client.ts         # ActualClient wrapper around @actual-app/api
│   ├── cli/
│   │   ├── args.ts           # CLI argument parsing
│   │   └── args.test.ts
│   ├── llm/
│   │   ├── anthropic.ts      # Anthropic adapter (Haiku for proposals, Sonnet for review)
│   │   ├── openai.ts         # OpenAI adapter (gpt-4o-mini for proposals, gpt-4o for review)
│   │   └── prompts.ts        # Prompt builders for all LLM interactions
│   ├── parsers/
│   │   ├── qfx.ts            # QFX/OFX file parser
│   │   └── qfx.test.ts
│   ├── rules/
│   │   ├── engine.ts         # Rule matching logic
│   │   ├── engine.test.ts
│   │   ├── normalize.ts      # extractMatchValue() — strips trailing codes from raw payees
│   │   ├── normalize.test.ts
│   │   ├── vetted.ts         # VettedRuleStore — JSON persistence for approved rules
│   │   └── vetted.test.ts
│   └── ui/
│       ├── browse.ts         # Main interactive browser + AI review pass
│       ├── browse.test.ts
│       ├── constants.ts      # TAG_CHOICES constant
│       ├── session.ts        # End-of-session flow (review rules, import, transfers)
│       ├── session.test.ts
│       ├── transfers.ts      # Transfer pair detection across accounts
│       ├── transfers.test.ts
│       ├── vetting.ts        # 3-stage vetting workflow (payee → category → tag)
│       └── vetting.test.ts   # (if present)
├── dist/                     # Compiled output (git-ignored)
├── data/                     # Actual Budget local cache (git-ignored)
├── .env.example              # Environment variable template
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5+ (strict mode) |
| Runtime | Node.js 20+ |
| Module system | ES Modules (`"type": "module"`) |
| Build | `tsc` → `dist/` |
| Dev runner | `tsx` (runs `.ts` files directly) |
| Test framework | Vitest 3.x |
| CLI prompts | `@inquirer/prompts` |
| Terminal styling | `chalk` |
| Budget backend | `@actual-app/api` |
| LLM (primary) | `@anthropic-ai/sdk` |
| LLM (alternate) | `openai` |
| Env config | `dotenv` |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values. Required variables:

```env
# Actual Budget connection
ACTUAL_SERVER_URL=https://your-actual-server
ACTUAL_PASSWORD=yourpassword
ACTUAL_BUDGET_ID=             # groupId from api.getBudgets()
ACTUAL_CA_CERT=               # optional: path to CA cert for self-signed TLS

# LLM provider — set one or both; provider auto-detected if only one key present
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# LLM_PROVIDER=anthropic      # explicit override

# Vetted rules persistence
VETTED_RULES_PATH=./vetted-rules.json

# Optional model overrides
# ANTHROPIC_FAST_MODEL=claude-haiku-4-5-20251001
# ANTHROPIC_REVIEW_MODEL=claude-sonnet-4-6
# OPENAI_MODEL=gpt-4o-mini
# OPENAI_REVIEW_MODEL=gpt-4o
```

---

## Core Concepts & Architecture

### Primary Goal

Budget Sherpa is a **rule management tool**. Its job is to ensure that when you import QFX files into Actual Budget's UI (or via `--import`), the rules already exist to clean payees and assign categories automatically. Transaction import is a secondary, optional step.

### Data Flow

```
QFX files
  → parse (qfx.ts)
  → group transactions by raw payee
  → classifyByRuleCoverage() — compare against existing Actual rules:
      • covered:       pre-rule + category rule exist → skip
      • needsCategory: pre-rule exists, no category → opt-in gap fill
      • uncovered:     no rules at all → full vetting
  → browseAndVet() with only uncovered payees:
      LLM proposes clean name + category (concurrent, max 5)
      human reviews/edits each group interactively
      AI review pass — batch suggestions for consolidating similar payees
  → optional: vetCategoryGaps() — assign categories to needsCategory payees
  → end-of-session (runEndOfSession):
      1. Edit/review session decisions
      2. Rule consolidation (opt-in AI pass)
      3. Create approved rules in Actual Budget
      4. Optional: dry-run import preview (shows new vs duplicate counts)
      5. [--import only] Import transactions (bare payload — rules do the work)
      6. [--import only] Detect and link transfer pairs
```

### 3-Stage Vetting Workflow (`src/ui/vetting.ts`)

Each payee group goes through three prompts in sequence:

1. **Payee stage** — clean the raw payee name (accept LLM suggestion or type custom)
2. **Category stage** — assign a budget category
3. **Tag stage** — optionally apply a tag

### Rule Key Format

Rules are persisted by a stable content hash (not Actual Budget's internal ID):

```
"{stage}:{field}:{op}:{matchValue}:{actionField}:{actionValue}"
```

- `stage` is `pre`, `null`, or `post`
- `pre` rules match raw payee; `null` rules match cleaned payee
- This key survives rule ID changes across Actual Budget syncs

### Rule Coverage Analysis (`src/rules/engine.ts`)

`classifyByRuleCoverage(rules, uniqueRawPayees, payeeById)` classifies each unique raw payee into:
- **`covered`** — Actual has both a pre-stage rule (raw→payee) and a null-stage category rule
- **`needsCategory`** — pre-stage rule exists but no category rule (opt-in fill)
- **`uncovered`** — no pre-stage rule matches at all (shown in main browser)

Category rule detection handles both ID-based conditions (`type: 'id'`, budget-sherpa style) and string-based conditions (`type: 'string'`, manually created in Actual UI).

### VettedRuleStore (`src/rules/vetted.ts`)

Persists approved rules between sessions in a JSON file:

```json
{
  "version": 1,
  "rules": { "<ruleKey>": { ...VettedRule } },
  "tags": { "<cleanPayee>": "<tagName>" }
}
```

Previously vetted payees are auto-skipped on subsequent runs.

`cleanCoveredByActual(actualRules, payeeById)` removes vetted store entries that are now fully represented in Actual's rule set (called at startup). This prevents the store from growing stale after rules are successfully created.

### LLM Adapter Interface (`src/types.ts`)

Both `AnthropicAdapter` and `OpenAIAdapter` implement `LLMAdapter`:

```typescript
interface LLMAdapter {
  proposePayee(rawPayees: string[]): Promise<string>;
  proposeCategory(cleanPayee: string, categories: string[]): Promise<string>;
  reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]>;
  suggestConsolidation(payees: string[]): Promise<ConsolidationSuggestion[]>;
}
```

Each adapter uses a **fast model** for per-payee proposals and a **review model** for batch review passes.

### Concurrency Control

LLM proposals run concurrently but are capped at 5 simultaneous requests via `withConcurrency()` in `src/ui/browse.ts` to avoid rate limiting.

### Transfer Detection (`src/ui/transfers.ts`)

- Scans all Actual Budget accounts (not just the current session's accounts)
- Matches transaction pairs with equal and opposite amounts within a 5-day window
- Prevents duplicate links using a `used` Set

---

## Key Type Definitions (`src/types.ts`)

```typescript
// Raw transaction from QFX file
interface RawTransaction {
  id: string;          // FITID from bank
  date: string;        // YYYY-MM-DD
  amount: number;      // In cents (negative = debit)
  rawPayee: string;
  account: string;
}

// After vetting
interface ProcessedTransaction {
  raw: RawTransaction;
  cleanPayee: string;
  category: string;
  preRuleKey?: string;      // Rule key for pre-stage (raw payee match)
  categoryRuleKey?: string; // Rule key for null-stage (clean payee match)
}

// Actual Budget rule structure
interface Rule {
  stage: "pre" | null | "post";
  conditionsOp: "and" | "or";
  conditions: Condition[];
  actions: Action[];
}

interface Condition {
  op: "contains" | "is" | "starts-with" | "ends-with" | "matches";
  field: string;
  value: string;
  type: string;
}

interface Action {
  op: "set" | "append-notes" | "prepend-notes";
  field: string;
  value: string;
  type: string;
}
```

---

## Testing Conventions

- Test files live **alongside** source files: `src/foo/bar.test.ts`
- Test runner: **Vitest** (configured in `vitest.config.ts`, pattern `src/**/*.test.ts`)
- Tests use `vi.mock()` for external dependencies (`@actual-app/api`, LLM adapters)
- No separate test directory; all tests colocated with source

**Always run tests after making changes:**

```bash
npm test
```

---

## Code Conventions

### TypeScript

- `"strict": true` is enforced — no implicit `any`, no unchecked optionals
- Module resolution: `NodeNext` — imports must include explicit `.js` extensions even for `.ts` source files (e.g., `import { foo } from "./foo.js"`)
- All new code must be fully typed; avoid `any`

### Error Handling

- Ctrl+C during interactive prompts throws `ExitPromptError` from `@inquirer/prompts` — always catch and handle gracefully to save progress
- Actual Budget cache staleness: detect and clear `data/` directory before retry
- Validate required env vars at startup with clear error messages

### No Linting Configuration

There is no ESLint or Prettier config. Follow the style visible in existing source files:
- 2-space indentation
- Single quotes for strings
- Trailing commas in multi-line structures
- `async/await` preferred over raw Promise chains

### Dry-Run Mode

When `--dry-run` is set, **no writes** should be made to Actual Budget. All `ActualClient` write methods (`createRule`, `createPayee`, `importTransactions`, `updateTransaction`) must be guarded. Check the `dryRun` flag from the parsed config before calling any write operation.

---

## Adding a New LLM Provider

1. Create `src/llm/<provider>.ts` implementing the `LLMAdapter` interface
2. Add provider detection logic in `src/index.ts` where the adapter is instantiated
3. Add relevant env vars to `.env.example`
4. Add model override env vars following the existing pattern

---

## Adding Support for New File Formats

Currently only QFX/OFX is supported. To add a new format (e.g., CSV):

1. Create `src/parsers/<format>.ts` with a function returning `RawTransaction[]`
2. Update `src/index.ts` to detect and dispatch to the new parser based on file extension
3. Add tests in `src/parsers/<format>.test.ts`

---

## Common Pitfalls

- **Import extensions**: Always use `.js` in import paths (even when importing `.ts` files) due to `NodeNext` module resolution.
- **Amount units**: `RawTransaction.amount` is in **dollars** (float, as parsed from QFX `<TRNAMT>`). It is multiplied by 100 in `buildTxPayload` before being sent to Actual Budget, which expects integer cents.
- **Bare import payload**: `buildTxPayload` intentionally omits `payee_name`, `category`, and `notes`. These fields are set by Actual's rules during import — do not re-add them to the payload.
- **Actual Budget API verbosity**: The `@actual-app/api` package logs heavily to stdout during sync. The codebase suppresses this by temporarily overriding `console.log`; preserve this behavior.
- **Rule keys are content-addressed**: Do not use Actual Budget's internal rule IDs for persistence — always use the computed content hash key.
- **Vetted store auto-skip**: On each startup, `cleanCoveredByActual` removes entries already in Actual. Remaining entries (pending rule creation) are auto-skipped during vetting. If a payee isn't appearing, check both Actual's rules and `vetted-rules.json`.
- **`getCategoryGroups` not `getCategories`**: The browser uses `getCategoryGroups()` for the grouped picker. `getCategories()` is still used in `session.ts` for name→ID resolution during rule creation.

---

## External Services

| Service | Purpose | Docs |
|---------|---------|------|
| Actual Budget | Budget backend | https://actualbudget.org/docs/developers/API |
| Anthropic API | LLM (default) | https://docs.anthropic.com |
| OpenAI API | LLM (alternate) | https://platform.openai.com/docs |
