import 'dotenv/config';
import { readdirSync } from 'fs';
import { resolve, basename } from 'path';
import chalk from 'chalk';

import { parseQfxFiles, parseQfxMeta } from './parsers/qfx.js';
import { ActualClient } from './actual/client.js';
import { AnthropicAdapter, DEFAULT_FAST_MODEL as ANTHROPIC_DEFAULT_FAST, DEFAULT_REVIEW_MODEL as ANTHROPIC_DEFAULT_REVIEW } from './llm/anthropic.js';
import { OpenAIAdapter, DEFAULT_FAST_MODEL as OPENAI_DEFAULT_FAST, DEFAULT_REVIEW_MODEL as OPENAI_DEFAULT_REVIEW } from './llm/openai.js';
import { VettedRuleStore } from './rules/vetted.js';
import { classifyByRuleCoverage } from './rules/engine.js';
import { runEndOfSession } from './ui/session.js';
import { browseAndVet, vetCategoryGaps } from './ui/browse.js';
import { parseCliArgs } from './cli/args.js';
import { input, select, confirm } from '@inquirer/prompts';
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
    dryRun:           false, // overridden below from CLI args
    anthropicFastModel:   process.env.ANTHROPIC_FAST_MODEL,
    anthropicReviewModel: process.env.ANTHROPIC_REVIEW_MODEL,
    openaiModel:          process.env.OPENAI_MODEL,
    openaiReviewModel:    process.env.OPENAI_REVIEW_MODEL,
  };
}

// --- File discovery ---

export function findQfxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(f => /\.(qfx|ofx)$/i.test(f))
    .map(f => resolve(dir, f));
}

// --- Main ---

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const config = loadConfig();
  config.dryRun = args.dryRun;

  if (config.actualCaCert) {
    process.env.NODE_EXTRA_CA_CERTS = config.actualCaCert;
  }

  const qfxDir = resolve(args.dir);
  const qfxFiles = findQfxFiles(qfxDir);

  if (qfxFiles.length === 0) {
    console.error('No QFX/OFX files found in directory: ' + qfxDir);
    process.exit(1);
  }

  console.log(chalk.bold('\n🏔  Budget Sherpa\n'));
  if (config.dryRun) {
    console.log(chalk.bold.yellow('[DRY RUN — no changes will be made to Actual Budget]\n'));
  }
  if (args.import) {
    console.log(chalk.bold.blue('[IMPORT MODE — transactions will be imported after rule creation]\n'));
  }
  console.log(`Found ${qfxFiles.length} QFX/OFX file(s)`);

  const qfxMeta = parseQfxMeta(qfxFiles);
  const transactions = parseQfxFiles(qfxFiles);
  console.log(`Parsed ${transactions.length} transactions\n`);

  // Connect to Actual Budget
  const actual = new ActualClient();
  await actual.init(config.actualServerUrl, config.actualPassword, config.actualBudgetId);

  const [rules, payees, categoryGroups, existingAccounts] = await Promise.all([
    actual.getRules(),
    actual.getPayees(),
    actual.getCategoryGroups(),
    actual.getAccounts(),
  ]);

  const llm = config.llmProvider === 'openai'
    ? new OpenAIAdapter(config.openaiApiKey!, {
        fastModel:   config.openaiModel,
        reviewModel: config.openaiReviewModel,
      })
    : new AnthropicAdapter(config.anthropicApiKey!, {
        fastModel:   config.anthropicFastModel,
        reviewModel: config.anthropicReviewModel,
      });

  {
    const fast   = config.llmProvider === 'openai'
      ? (config.openaiModel       ?? OPENAI_DEFAULT_FAST)
      : (config.anthropicFastModel   ?? ANTHROPIC_DEFAULT_FAST);
    const review = config.llmProvider === 'openai'
      ? (config.openaiReviewModel ?? OPENAI_DEFAULT_REVIEW)
      : (config.anthropicReviewModel ?? ANTHROPIC_DEFAULT_REVIEW);
    console.log(chalk.dim(`LLM: ${config.llmProvider}  (fast: ${fast}, review: ${review})\n`));
  }
  const vetted = new VettedRuleStore(config.vettedRulesPath);

  // Build lookup maps
  const knownPayeeNames = payees.map(p => p.name);
  const payeeById = new Map(payees.map(p => [p.id, p.name]));

  // Remove vetted store entries that are now fully represented in Actual's rules
  vetted.cleanCoveredByActual(rules, payeeById);

  // Group transactions by raw payee
  const byRawPayee = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    if (!byRawPayee.has(tx.rawPayee)) byRawPayee.set(tx.rawPayee, []);
    byRawPayee.get(tx.rawPayee)!.push(tx);
  }
  const uniquePayees = [...byRawPayee.keys()];

  // ── Rule coverage analysis ─────────────────────────────────────────────────
  const coverage = classifyByRuleCoverage(rules, uniquePayees, payeeById);

  console.log(chalk.bold('── Rule Coverage ────────────────────────────'));
  if (coverage.covered.length > 0) {
    console.log(chalk.dim(`  ${coverage.covered.length.toString().padStart(3)} payee(s)  fully covered (payee + category rules exist)`));
  }
  if (coverage.needsCategory.length > 0) {
    console.log(chalk.yellow(`  ${coverage.needsCategory.length.toString().padStart(3)} payee(s)  have payee rule but no category rule`));
  }
  if (coverage.uncovered.length > 0) {
    console.log(chalk.red(`  ${coverage.uncovered.length.toString().padStart(3)} payee(s)  have no rules at all`));
  }

  const gapCount = coverage.uncovered.length + coverage.needsCategory.length;
  if (gapCount === 0) {
    console.log(chalk.bold.green('\nAll payees are fully covered — no rule gaps found.'));
  } else {
    console.log(chalk.bold(`\nProceeding with ${coverage.uncovered.length} uncovered payee(s).`));
  }

  // Wrap all interactive work in one try/catch so Ctrl+C anywhere shuts down cleanly.
  try {
    // ── Account mapping ────────────────────────────────────────────────────────

    const accountMapping = new Map<string, string>(); // qfxAcctId → actualAccountId

    for (const meta of qfxMeta) {
      const filename = basename(meta.filepath);
      console.log(chalk.bold(`\n── Account: …${meta.lastFour} (${meta.acctType}) ← ${filename} ──────────────────`));

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

    // ── Browse & vet uncovered payees ─────────────────────────────────────────

    let payeeMap = new Map<string, string>();

    if (coverage.uncovered.length > 0) {
      const uncoveredByRawPayee = new Map(
        coverage.uncovered.map(p => [p, byRawPayee.get(p)!]),
      );
      console.log(`\n${coverage.uncovered.length} payee(s) need rules\n`);

      const result = await browseAndVet(
        coverage.uncovered, uncoveredByRawPayee, rules, vetted, llm,
        knownPayeeNames, categoryGroups, payeeById,
      );
      payeeMap = result.payeeMap;

      if (result.quit) {
        console.log(chalk.yellow('\nDecisions saved. Run again to create rules and finish.'));
        await actual.shutdown();
        return;
      }
    }

    // ── Category gap filling (opt-in) ─────────────────────────────────────────

    if (coverage.needsCategory.length > 0) {
      console.log('');
      const fillGaps = await confirm({
        message: `${coverage.needsCategory.length} payee(s) have payee rules but no category rule. Assign categories now?`,
        default: false,
      });
      if (fillGaps) {
        const needsCatByRawPayee = new Map(
          coverage.needsCategory.map(p => [p, byRawPayee.get(p)!]),
        );
        await vetCategoryGaps(
          coverage.needsCategory, needsCatByRawPayee, rules, vetted, llm,
          categoryGroups, payeeById,
        );
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(chalk.bold('\n── Summary ───────────────────────────────────'));
    console.log(`Transactions:  ${transactions.length}`);
    console.log(`Rule gaps:     ${coverage.uncovered.length + coverage.needsCategory.length} payee(s) reviewed`);

    // ── End-of-session: rules + optional import ───────────────────────────────
    const tagLookup = (cleanPayee: string) => vetted.getTag(cleanPayee);
    await runEndOfSession(
      vetted, transactions, payeeMap, tagLookup, accountMapping, actual,
      args.skipTransfers, config.dryRun, args.import, llm,
    );

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
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err);
  process.exit(1);
});
