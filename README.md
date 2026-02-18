# Budget Sherpa 🏔

An interactive CLI that guides you through importing financial transactions into [Actual Budget](https://actualbudget.org) with LLM-assisted rule building.

Instead of manually creating payee and category rules upfront, Budget Sherpa walks you through your transactions one payee at a time, proposes rules using an LLM, and learns your preferences over time. Once a rule is approved it is saved locally and reused silently on every future import — you only ever see a prompt for genuinely new payees.

## How it works

For each unique raw payee in your QFX files, Budget Sherpa runs three vetting stages:

**Stage 1 — Payee cleaning**
Strips variable trailing codes from the raw bank string (transaction IDs, store numbers, location suffixes) to produce a stable match pattern, then proposes a clean display name via the LLM.

```
Raw payee:     AMAZON MKTPL*0C2091XO3
Match pattern: AMAZON MKTPL          ← one rule covers all permutations
Proposed:      Amazon
```

You can accept, edit the name, edit the match pattern, or skip.

**Stage 2 — Category assignment**
Proposes a category from your Actual Budget category list. You can accept, choose from the full list, or skip.

**Stage 3 — Tag assignment**
Tags the payee for spending analysis using Actual Budget's native `#hashtag` notes system:

- `#fixed` — baseline expenses you can't avoid (mortgage, insurance)
- `#discretionary` — optional day-to-day spending
- `#subscription` — recurring services

Tags are stored in `vetted-rules.json` alongside the payee and category rules, and a dedicated Actual Budget rule is created (`append-notes #tag`) so future imports are tagged automatically.

**End of session**
When you finish vetting (or press Ctrl+C to save progress and exit), Budget Sherpa prompts you to:

1. Review the new rules created this session
2. Create them in Actual Budget (payee cleaning rules, category rules, tag rules)
3. Import all transactions — rules are applied automatically during import, and `imported_id` (FITID from the QFX file) prevents duplicates on re-import
4. Detect and link transfers between accounts

**Transfer detection**
After import, Budget Sherpa scans all imported accounts for transaction pairs where amounts cancel out (e.g. a -$1,500 in checking and a +$1,500 in a credit card account within 5 days). Confirmed pairs are linked using Actual Budget's transfer payee system so they don't appear as income or expense.

**Persistence and restarts**
All approved rules are saved to `vetted-rules.json` immediately on approval. If you stop mid-session (Ctrl+C or crash), the next run resumes from where you left off — already-vetted payees are skipped silently.

## Requirements

- [Actual Budget](https://actualbudget.org) server (self-hosted)
- Node.js 20+
- An Anthropic API key (or adapt `src/llm/` for another provider)

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
ACTUAL_BUDGET_ID=your-sync-id        # Settings → Advanced → Sync ID
ACTUAL_CA_CERT=/path/to/ca.crt       # only needed for self-signed TLS certs

ANTHROPIC_API_KEY=sk-ant-...

VETTED_RULES_PATH=./vetted-rules.json  # optional, defaults to this
```

> **Finding your Sync ID:** In Actual Budget, go to Settings → Advanced → Sync ID.

## Usage

```bash
# Source your .env so NODE_EXTRA_CA_CERTS is set before Node starts
set -a && source .env && set +a

npm run dev -- --dir /path/to/qfx/files
```

Budget Sherpa will:

1. Connect to your Actual Budget server (auto-recovers if the local cache is stale)
2. Map each QFX account to an Actual Budget account (or create new accounts)
3. Walk through unique payees: clean → categorize → tag
4. At session end: review rules → create in Actual Budget → import → link transfers

On subsequent runs, previously approved payees are skipped automatically.

## Account mapping

Budget Sherpa detects whether each QFX file is a credit card or checking account (`<CCACCTFROM>` vs `<BANKACCTFROM>`) and prompts you to map each to an existing Actual Budget account or create a new one.

## Project structure

```
src/
  types.ts              — shared types
  parsers/qfx.ts        — QFX/OFX file parser and account metadata
  rules/
    engine.ts           — rule matching logic (contains, is, starts-with, …)
    normalize.ts        — match pattern extraction (strips trailing codes)
    vetted.ts           — approved rule + tag persistence
  llm/
    anthropic.ts        — Anthropic (Claude Haiku) adapter
  actual/
    client.ts           — Actual Budget API wrapper
  ui/
    vetting.ts          — three-stage interactive vetting loop
    session.ts          — end-of-session flow (rules, import, transfers)
    transfers.ts        — post-import transfer detection and linking
  index.ts              — entry point
```

## LLM providers

Budget Sherpa ships with an Anthropic adapter using `claude-haiku` for fast, low-cost proposals. To use a different provider, implement the `LLMAdapter` interface in `src/llm/` and swap it in `src/index.ts`.

## Supported file formats

- QFX / OFX (recommended — includes transaction IDs for deduplication)

CSV support is planned.

## Contributing

Early-stage open source project. Contributions welcome — especially:

- Additional LLM adapters (OpenAI, Ollama)
- CSV parser
- Tests
