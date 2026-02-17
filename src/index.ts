import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

import { parseQfxFiles } from './parsers/qfx.js';
import { ActualClient } from './actual/client.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { VettedRuleStore } from './rules/vetted.js';
import { vetPayeeRule, vetCategoryRule } from './ui/vetting.js';
import type { Config, RawTransaction } from './types.js';

// --- Config ---

function loadConfig(): Config {
  const required = (key: string) => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };
  return {
    actualServerUrl:  required('ACTUAL_SERVER_URL'),
    actualPassword:   required('ACTUAL_PASSWORD'),
    actualBudgetId:   required('ACTUAL_BUDGET_ID'),
    actualCaCert:     process.env.ACTUAL_CA_CERT,
    anthropicApiKey:  required('ANTHROPIC_API_KEY'),
    vettedRulesPath:  process.env.VETTED_RULES_PATH ?? './vetted-rules.json',
  };
}

// --- Main ---

const config = loadConfig();

if (config.actualCaCert) {
  process.env.NODE_EXTRA_CA_CERTS = config.actualCaCert;
}

// Find QFX files — use --dir argument or current directory
const dirArg = process.argv.find(a => a.startsWith('--dir='))?.slice(6)
  ?? process.argv[process.argv.indexOf('--dir') + 1];
const qfxDir = resolve(dirArg ?? '.');

const qfxFiles = readdirSync(qfxDir)
  .filter(f => f.toLowerCase().endsWith('.qfx'))
  .map(f => resolve(qfxDir, f));

if (qfxFiles.length === 0) {
  console.error('No QFX files found in current directory.');
  process.exit(1);
}

console.log(chalk.bold('\n🏔  Budget Sherpa\n'));
console.log(`Found ${qfxFiles.length} QFX file(s)`);

const transactions = parseQfxFiles(qfxFiles);
console.log(`Parsed ${transactions.length} transactions\n`);

// Connect to Actual Budget
const actual = new ActualClient();
await actual.init(config.actualServerUrl, config.actualPassword, config.actualBudgetId);

const [rules, payees, categories] = await Promise.all([
  actual.getRules(),
  actual.getPayees(),
  actual.getCategories(),
]);

const knownPayeeNames = payees.map(p => p.name);
const categoryNames = categories.map(c => c.name);

const llm = new AnthropicAdapter(config.anthropicApiKey);
const vetted = new VettedRuleStore(config.vettedRulesPath);

// Group transactions by raw payee
const byRawPayee = new Map<string, RawTransaction[]>();
for (const tx of transactions) {
  if (!byRawPayee.has(tx.rawPayee)) byRawPayee.set(tx.rawPayee, []);
  byRawPayee.get(tx.rawPayee)!.push(tx);
}

const uniquePayees = [...byRawPayee.keys()];
console.log(`${uniquePayees.length} unique raw payees to process\n`);

// ── Stage 1: Payee cleaning ──────────────────────────────────────────
console.log(chalk.bold.blue('Stage 1: Payee cleaning\n'));

const payeeMap = new Map<string, string>(); // rawPayee → cleanPayee

for (const rawPayee of uniquePayees) {
  const txs = byRawPayee.get(rawPayee)!;
  const result = await vetPayeeRule(rawPayee, txs, rules, vetted, llm, knownPayeeNames);
  if (result) {
    payeeMap.set(rawPayee, result.cleanPayee);
    if (!knownPayeeNames.includes(result.cleanPayee)) {
      knownPayeeNames.push(result.cleanPayee);
    }
  }
}

// ── Stage 2: Category assignment ─────────────────────────────────────
console.log(chalk.bold.blue('\nStage 2: Category assignment\n'));

// Group by clean payee (many raw payees may share a clean payee)
const byCleanPayee = new Map<string, RawTransaction[]>();
for (const [rawPayee, cleanPayee] of payeeMap) {
  if (!byCleanPayee.has(cleanPayee)) byCleanPayee.set(cleanPayee, []);
  byCleanPayee.get(cleanPayee)!.push(...byRawPayee.get(rawPayee)!);
}

const categoryMap = new Map<string, string>(); // cleanPayee → category

for (const cleanPayee of byCleanPayee.keys()) {
  const result = await vetCategoryRule(cleanPayee, rules, vetted, llm, categoryNames);
  if (result) categoryMap.set(cleanPayee, result.category);
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(chalk.bold.green('\n── Summary ─────────────────────────────────'));
console.log(`Transactions:  ${transactions.length}`);
console.log(`Payees mapped: ${payeeMap.size} / ${uniquePayees.length}`);
console.log(`Categorized:   ${categoryMap.size} clean payees`);

await actual.shutdown();
