import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

process.on('SIGINT', () => {
  console.log(chalk.yellow('\n\nProgress saved. Goodbye!'));
  process.exit(0);
});

import { parseQfxFiles, parseQfxMeta } from './parsers/qfx.js';
import { ActualClient } from './actual/client.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { VettedRuleStore } from './rules/vetted.js';
import { vetPayeeRule, vetCategoryRule, vetTag } from './ui/vetting.js';
import { runEndOfSession } from './ui/session.js';
import { input, select } from '@inquirer/prompts';
import type { Config } from './types.js';

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

const qfxMeta = parseQfxMeta(qfxFiles);
const transactions = parseQfxFiles(qfxFiles);
console.log(`Parsed ${transactions.length} transactions\n`);

// Connect to Actual Budget
const actual = new ActualClient();
await actual.init(config.actualServerUrl, config.actualPassword, config.actualBudgetId);

const [rules, payees, categories, existingAccounts] = await Promise.all([
  actual.getRules(),
  actual.getPayees(),
  actual.getCategories(),
  actual.getAccounts(),
]);

// ── Account detection / creation ──────────────────────────────────────────────

const accountMapping = new Map<string, string>(); // qfxAcctId → actualAccountId
const accountsByName = new Map(existingAccounts.map(a => [a.name.toLowerCase(), a.id]));

for (const meta of qfxMeta) {
  console.log(chalk.bold(`── Account: …${meta.lastFour} (${meta.acctType}) ──────────────────`));

  if (existingAccounts.length > 0) {
    // Let user pick an existing account or create new
    const choices = [
      ...existingAccounts.map(a => ({ name: a.name, value: a.id })),
      { name: '+ Create new account', value: '__new__' },
    ];
    const choice = await select({
      message: `Map QFX account "${meta.acctId}" to:`,
      choices,
    });

    if (choice !== '__new__') {
      accountMapping.set(meta.acctId, choice);
      const name = existingAccounts.find(a => a.id === choice)?.name;
      console.log(chalk.green(`✓ Mapped to "${name}"`));
      continue;
    }
  }

  // Create new account
  const name = await input({
    message: `Name for this ${meta.acctType} account:`,
    default: `Chase ${meta.lastFour}`,
  });
  const id = await actual.createAccount({ name, type: meta.acctType });
  existingAccounts.push({ id, name });
  accountMapping.set(meta.acctId, id);
  console.log(chalk.green(`✓ Created account "${name}"`));
}

// ── Vetting setup ─────────────────────────────────────────────────────────────

const knownPayeeNames = payees.map(p => p.name);
const categoryNames = categories.map(c => c.name);
const categoryById = new Map(categories.map(c => [c.id, c.name]));
const payeeById = new Map(payees.map(p => [p.id, p.name]));

const llm = new AnthropicAdapter(config.anthropicApiKey);
const vetted = new VettedRuleStore(config.vettedRulesPath);

// Group transactions by raw payee
const byRawPayee = new Map<string, typeof transactions>();
for (const tx of transactions) {
  if (!byRawPayee.has(tx.rawPayee)) byRawPayee.set(tx.rawPayee, []);
  byRawPayee.get(tx.rawPayee)!.push(tx);
}

const uniquePayees = [...byRawPayee.keys()];
console.log(`\n${uniquePayees.length} unique raw payees to process\n`);

// ── Per-payee: clean → categorize → tag ──────────────────────────────────────

const payeeMap = new Map<string, string>();    // rawPayee → cleanPayee
const vettedCleanPayees = new Set<string>();   // avoid re-prompting for shared clean names

try {
  for (const rawPayee of uniquePayees) {
    const txs = byRawPayee.get(rawPayee)!;

    // Stage 1: clean the raw payee
    const payeeResult = await vetPayeeRule(rawPayee, txs, rules, vetted, llm, knownPayeeNames, payeeById);
    if (!payeeResult) continue;

    const { cleanPayee } = payeeResult;
    payeeMap.set(rawPayee, cleanPayee);
    if (!knownPayeeNames.includes(cleanPayee)) knownPayeeNames.push(cleanPayee);

    // Stages 2 + 3: category and tag (only once per unique clean payee)
    if (!vettedCleanPayees.has(cleanPayee)) {
      vettedCleanPayees.add(cleanPayee);
      await vetCategoryRule(cleanPayee, rules, vetted, llm, categoryNames, categoryById);
      await vetTag(cleanPayee, vetted);
    }
  }
} catch (err: any) {
  if (err?.name === 'ExitPromptError') {
    console.log(chalk.yellow('\n\nProgress saved.'));
  } else {
    await actual.shutdown();
    throw err;
  }
}

// ── Vetting summary ───────────────────────────────────────────────────────────
console.log(chalk.bold('\n── Vetting Summary ──────────────────────────'));
console.log(`Transactions:  ${transactions.length}`);
console.log(`Payees mapped: ${payeeMap.size} / ${uniquePayees.length}`);

// ── End-of-session: review rules + import ────────────────────────────────────
const tagLookup = (cleanPayee: string) => vetted.getTag(cleanPayee);

try {
  await runEndOfSession(vetted.getSessionRules(), transactions, payeeMap, tagLookup, accountMapping, actual);
} catch (err: any) {
  if (err?.name !== 'ExitPromptError') throw err;
}

await actual.shutdown();
console.log(chalk.bold.green('\nGoodbye!'));
