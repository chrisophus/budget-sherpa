import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';

import { parseQfxFiles, parseQfxMeta } from './parsers/qfx.js';
import { ActualClient } from './actual/client.js';
import { AnthropicAdapter } from './llm/anthropic.js';
import { OpenAIAdapter } from './llm/openai.js';
import { VettedRuleStore } from './rules/vetted.js';
import { runEndOfSession } from './ui/session.js';
import { browseAndVet } from './ui/browse.js';
import { input, select } from '@inquirer/prompts';
import type { Config } from './types.js';

// --- Config ---

function loadConfig(): Config {
  const required = (key: string) => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const openaiApiKey = process.env.OPENAI_API_KEY;

  let llmProvider = process.env.LLM_PROVIDER as 'anthropic' | 'openai' | undefined;
  if (!llmProvider) {
    if (anthropicApiKey) llmProvider = 'anthropic';
    else if (openaiApiKey) llmProvider = 'openai';
    else throw new Error('Missing LLM API key: set ANTHROPIC_API_KEY or OPENAI_API_KEY');
  }

  if (llmProvider === 'anthropic' && !anthropicApiKey) {
    throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set');
  }
  if (llmProvider === 'openai' && !openaiApiKey) {
    throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set');
  }

  return {
    actualServerUrl:  required('ACTUAL_SERVER_URL'),
    actualPassword:   required('ACTUAL_PASSWORD'),
    actualBudgetId:   required('ACTUAL_BUDGET_ID'),
    actualCaCert:     process.env.ACTUAL_CA_CERT,
    llmProvider,
    anthropicApiKey,
    openaiApiKey,
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

const llm = config.llmProvider === 'openai'
  ? new OpenAIAdapter(config.openaiApiKey!)
  : new AnthropicAdapter(config.anthropicApiKey!);
const vetted = new VettedRuleStore(config.vettedRulesPath);

// Wrap all interactive work in one try/catch so Ctrl+C anywhere
// (account mapping, vetting, end-of-session) shuts down cleanly.
try {
  // ── Account detection / creation ────────────────────────────────────────────

  const accountMapping = new Map<string, string>(); // qfxAcctId → actualAccountId

  for (const meta of qfxMeta) {
    console.log(chalk.bold(`── Account: …${meta.lastFour} (${meta.acctType}) ──────────────────`));

    if (existingAccounts.length > 0) {
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

    const name = await input({
      message: `Name for this ${meta.acctType} account:`,
      default: `Chase ${meta.lastFour}`,
    });
    const id = await actual.createAccount({ name, type: meta.acctType });
    existingAccounts.push({ id, name });
    accountMapping.set(meta.acctId, id);
    console.log(chalk.green(`✓ Created account "${name}"`));
  }

  // ── Browse & vet ──────────────────────────────────────────────────────────

  const knownPayeeNames = payees.map(p => p.name);
  const categoryNames = categories.map(c => c.name);
  const payeeById = new Map(payees.map(p => [p.id, p.name]));

  // Group transactions by raw payee
  const byRawPayee = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    if (!byRawPayee.has(tx.rawPayee)) byRawPayee.set(tx.rawPayee, []);
    byRawPayee.get(tx.rawPayee)!.push(tx);
  }

  const uniquePayees = [...byRawPayee.keys()];
  console.log(`\n${uniquePayees.length} unique raw payees`);

  const { payeeMap, quit } = await browseAndVet(
    uniquePayees, byRawPayee, rules, vetted, llm,
    knownPayeeNames, categoryNames, payeeById,
  );

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(chalk.bold('\n── Summary ───────────────────────────────────'));
  console.log(`Transactions:  ${transactions.length}`);
  console.log(`Payees mapped: ${payeeMap.size} / ${uniquePayees.length}`);

  if (quit) {
    console.log(chalk.yellow('\nDecisions saved to vetted-rules.json. Run again to create rules and import.'));
  } else {
    // ── End-of-session: review rules + import ───────────────────────────────
    const tagLookup = (cleanPayee: string) => vetted.getTag(cleanPayee);
    await runEndOfSession(vetted, transactions, payeeMap, tagLookup, accountMapping, actual);
  }

} catch (err: any) {
  if (err?.name === 'ExitPromptError') {
    console.log(chalk.yellow('\n\nProgress saved.'));
  } else {
    await actual.shutdown();
    throw err;
  }
}

await actual.shutdown();
console.log(chalk.bold.green('\nGoodbye!'));
