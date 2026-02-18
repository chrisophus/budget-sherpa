import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { VettedRule, RawTransaction } from '../types.js';
import type { ActualClient } from '../actual/client.js';

// ── Rule creation ─────────────────────────────────────────────────────────────

async function createRulesInActual(
  rules: VettedRule[],
  tagLookup: (cleanPayee: string) => string | null,
  actual: ActualClient,
): Promise<void> {
  const [payees, categories] = await Promise.all([
    actual.getPayees(),
    actual.getCategories(),
  ]);

  const payeeByName = new Map(payees.map(p => [p.name.toLowerCase(), p.id]));
  const categoryByName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));

  let created = 0;

  // Pass 1: pre-stage payee cleaning rules (may create new payees)
  for (const rule of rules.filter(r => r.stage === 'pre')) {
    let payeeId = payeeByName.get(rule.actionValue.toLowerCase());
    if (!payeeId) {
      payeeId = await actual.createPayee(rule.actionValue);
      payeeByName.set(rule.actionValue.toLowerCase(), payeeId);
    }
    try {
      await actual.createRule({
        stage: 'pre',
        conditionsOp: 'and',
        conditions: [{ op: rule.matchOp, field: rule.matchField, value: rule.matchValue, type: 'string' }],
        actions: [{ op: 'set', field: 'payee', value: payeeId, type: 'id' }],
      });
      created++;
      console.log(chalk.green(`  ✓ [pre] ${rule.matchValue} → ${rule.actionValue}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ [pre] ${rule.matchValue}: ${err.message ?? err}`));
    }
  }

  // Pass 2: category rules, with optional tag (notes) rule
  for (const rule of rules.filter(r => r.stage === null)) {
    const payeeId = payeeByName.get(rule.matchValue.toLowerCase());
    const categoryId = categoryByName.get(rule.actionValue.toLowerCase());

    if (!payeeId) {
      console.log(chalk.yellow(`  ⚠ Skipping category rule for "${rule.matchValue}" — payee not found`));
      continue;
    }
    if (!categoryId) {
      console.log(chalk.yellow(`  ⚠ Skipping category "${rule.actionValue}" — not found in Actual`));
      continue;
    }

    const condition = { op: 'is', field: 'payee', value: payeeId, type: 'id' } as const;

    try {
      await actual.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [condition],
        actions: [{ op: 'set', field: 'category', value: categoryId, type: 'id' }],
      });
      created++;
      console.log(chalk.green(`  ✓ [cat] ${rule.matchValue} → ${rule.actionValue}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ [cat] ${rule.matchValue}: ${err.message ?? err}`));
    }

    // Create a notes/tag rule if this payee has a tag
    const tag = tagLookup(rule.matchValue);
    if (tag) {
      try {
        await actual.createRule({
          stage: null,
          conditionsOp: 'and',
          conditions: [condition],
          actions: [{ op: 'set', field: 'notes', value: `#${tag}`, type: 'string' as any }],
        });
        created++;
        console.log(chalk.green(`  ✓ [tag] ${rule.matchValue} → #${tag}`));
      } catch (err: any) {
        console.log(chalk.red(`  ✗ [tag] ${rule.matchValue}: ${err.message ?? err}`));
      }
    }
  }

  console.log(chalk.bold.green(`\n✓ Created ${created} rules in Actual Budget`));
}

// ── Transaction import ────────────────────────────────────────────────────────

async function importTransactions(
  transactions: RawTransaction[],
  payeeMap: Map<string, string>,
  tagLookup: (cleanPayee: string) => string | null,
  accountMapping: Map<string, string>,
  actual: ActualClient,
): Promise<void> {
  const categories = await actual.getCategories();
  const categoryIdByName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));

  let totalAdded = 0;
  let totalUpdated = 0;

  for (const [qfxAcctId, actualAcctId] of accountMapping) {
    const acctTxs = transactions.filter(t => t.account === qfxAcctId);

    const payload = acctTxs.map(tx => {
      const cleanPayee = payeeMap.get(tx.rawPayee);
      const tag = cleanPayee ? tagLookup(cleanPayee) : null;

      // Convert YYYYMMDD → YYYY-MM-DD
      const date = `${tx.date.slice(0, 4)}-${tx.date.slice(4, 6)}-${tx.date.slice(6, 8)}`;
      // Convert to milliunits
      const amount = Math.round(tx.amount * 1000);

      return {
        date,
        amount,
        imported_id: tx.id,
        imported_payee: tx.rawPayee,
        ...(cleanPayee ? { payee_name: cleanPayee } : {}),
        ...(tag ? { notes: `#${tag}` } : {}),
      };
    });

    try {
      const result = await actual.importTransactions(actualAcctId, payload);
      totalAdded += result.added?.length ?? 0;
      totalUpdated += result.updated?.length ?? 0;
      console.log(chalk.green(`  ✓ ${acctTxs.length} transactions → account …${qfxAcctId.slice(-4)}`));
      if (result.errors?.length) {
        for (const e of result.errors) console.log(chalk.red(`    error: ${JSON.stringify(e)}`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ account ${qfxAcctId}: ${err.message ?? err}`));
    }
  }

  console.log(chalk.bold.green(`\n✓ Import complete: ${totalAdded} added, ${totalUpdated} updated`));
}

// ── Main end-of-session flow ──────────────────────────────────────────────────

export async function runEndOfSession(
  sessionRules: VettedRule[],
  transactions: RawTransaction[],
  payeeMap: Map<string, string>,
  tagLookup: (cleanPayee: string) => string | null,
  accountMapping: Map<string, string>,
  actual: ActualClient,
): Promise<void> {
  console.log('\n' + chalk.bold('── End of Session ───────────────────────────'));

  // --- New rules ---
  if (sessionRules.length > 0) {
    const preRules = sessionRules.filter(r => r.stage === 'pre');
    const catRules = sessionRules.filter(r => r.stage === null);
    console.log(`${chalk.bold(sessionRules.length)} new rules this session: ${preRules.length} payee, ${catRules.length} category`);

    const rulesAction = await select({
      message: 'What would you like to do with the new rules?',
      choices: [
        { name: `Review ${sessionRules.length} rules`, value: 'review' },
        { name: 'Create all in Actual Budget', value: 'create' },
        { name: 'Skip', value: 'skip' },
      ],
    });

    if (rulesAction === 'review') {
      console.log('');
      for (const rule of sessionRules) {
        const tag = rule.stage === null ? tagLookup(rule.matchValue) : null;
        const tagStr = tag ? chalk.dim(` #${tag}`) : '';
        if (rule.stage === 'pre') {
          console.log(`  ${chalk.dim('pre')}  ${chalk.yellow(rule.matchValue)} → ${chalk.cyan(rule.actionValue)}`);
        } else {
          console.log(`  ${chalk.dim('cat')}  ${chalk.cyan(rule.matchValue)} → ${chalk.magenta(rule.actionValue)}${tagStr}`);
        }
      }
      console.log('');

      const doCreate = await confirm({
        message: `Create these rules in Actual Budget?`,
        default: true,
      });
      if (doCreate) {
        await createRulesInActual(sessionRules, tagLookup, actual);
      }
    } else if (rulesAction === 'create') {
      await createRulesInActual(sessionRules, tagLookup, actual);
    }
  } else {
    console.log('No new rules this session.');
  }

  // --- Import transactions ---
  const mappedTxCount = transactions.filter(t => payeeMap.has(t.rawPayee)).length;
  const doImport = await confirm({
    message: `Import ${transactions.length} transactions (${mappedTxCount} with mapped payees)?`,
    default: true,
  });

  if (doImport) {
    await importTransactions(transactions, payeeMap, tagLookup, accountMapping, actual);
  }
}
