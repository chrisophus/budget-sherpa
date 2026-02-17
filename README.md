# Budget Sherpa 🏔

An interactive CLI that guides you through importing financial transactions into [Actual Budget](https://actualbudget.org) with LLM-assisted rule building.

Instead of manually creating payee and category rules upfront, Budget Sherpa walks you through your transactions, proposes rules using an LLM, and learns your preferences over time. Once a rule is approved, future transactions matching that rule are processed automatically without prompting.

## How it works

Importing runs in two stages:

**Stage 1 — Payee cleaning**
For each unique raw payee name from your bank (e.g. `AMAZON MKTPL*N39PO6NS3`), Budget Sherpa finds or proposes a clean name (e.g. `Amazon`). You approve, edit, or skip. The approved rule is saved and reused for all future imports.

**Stage 2 — Category assignment**
For each unique clean payee, Budget Sherpa proposes a category based on your Actual Budget category list. Same approval loop. Same persistence.

Over time, most transactions will match already-approved rules and require no input at all.

## Requirements

- [Actual Budget](https://actualbudget.org) server running and accessible
- Node.js 20+
- An Anthropic API key (or adapt `src/llm/` for OpenAI/Ollama)

## Setup

```bash
git clone https://github.com/chrisophus/budget-sherpa
cd budget-sherpa
npm install
cp .env.example .env
```

Edit `.env`:

```env
ACTUAL_SERVER_URL=https://your-actual-budget-server
ACTUAL_PASSWORD=yourpassword
ACTUAL_BUDGET_ID=your-budget-group-id   # find this via getBudgets()
ACTUAL_CA_CERT=./path/to/ca.crt         # if using a self-signed cert

ANTHROPIC_API_KEY=sk-ant-...
```

To find your `ACTUAL_BUDGET_ID`, run:

```bash
npm run dev -- --list-budgets
```

## Usage

Drop your QFX files in the project directory and run:

```bash
npm run dev
```

Budget Sherpa will:
1. Parse all `.qfx` files in the current directory
2. Connect to your Actual Budget server
3. Walk through unique payees for Stage 1 (payee cleaning)
4. Walk through clean payees for Stage 2 (category assignment)
5. Save all approved rules to `vetted-rules.json`

On subsequent runs, previously approved rules are applied silently — only new or unvetted payees prompt for input.

## Project structure

```
src/
  types.ts          — shared types
  parsers/qfx.ts    — QFX/OFX file parser
  rules/
    engine.ts       — rule matching logic
    vetted.ts       — approved rule persistence
  llm/
    anthropic.ts    — Anthropic (Claude) adapter
  actual/
    client.ts       — Actual Budget API wrapper
  ui/
    vetting.ts      — two-stage interactive vetting loop
  index.ts          — entry point
```

## Supported file formats

- QFX / OFX (recommended — includes transaction IDs for deduplication)

CSV support is planned.

## LLM providers

Budget Sherpa currently ships with an Anthropic adapter using `claude-haiku` for fast, low-cost proposals. To use a different provider, implement the `LLMAdapter` interface in `src/llm/` and swap it in `src/index.ts`.

## Contributing

This is an early-stage open source project. Contributions welcome — especially:
- Additional LLM adapters (OpenAI, Ollama)
- CSV parser
- Additional file format parsers
- Tests
