import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { VettedRule, RawTransaction } from '../types.js';
import type { ActualClient } from '../actual/client.js';

// ── Rule creation ─────────────────────────────────────────────────────────────

async function createRulesInActual(rules: VettedRule[], actual: ActualClient): Promise<void> {
  const [payees, categories] = await Promise.all([
    actual.getPayees(),
    actual.getCategories(),
  ]);

  const payeeByName = new Map(payees.map(p => [p.name.toLowerCase(), p.id]));
  const categoryByName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));

  let created = 0;

  // Pass 1: pre-stage payee rules (may create new payees)
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
      console.log(chalk.green(`  ✓ ${rule.matchValue} → ${rule.actionValue}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${rule.matchValue}: ${err.message ?? err}`));
    }
  }

  // Pass 2: category rules (null stage, depend on payees existing)
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

    try {
      await actual.createRule({
        stage: null,
        conditionsOp: 'and',
        conditions: [{ op: 'is', field: 'payee', value: payeeId, type: 'id' }],
        actions: [{ op: 'set', field: 'category', value: categoryId, type: 'id' }],
      });
      created++;
      console.log(chalk.green(`  ✓ ${rule.matchValue} → ${rule.actionValue}`));
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${rule.matchValue}: ${err.message ?? err}`));
    }
  }

  console.log(chalk.bold.green(`\n✓ Created ${created} of ${rules.length} rules in Actual Budget`));
}

// ── Transaction import ────────────────────────────────────────────────────────

async function importTransactions(
  transactions: RawTransaction[],
  payeeMap: Map<string, string>,
  categoryMap: Map<string, string>,
  actual: ActualClient,
): Promise<void> {
  const accounts = await actual.getAccounts();
  if (accounts.length === 0) {
    console.log(chalk.yellow('No accounts found in Actual Budget.'));
    return;
  }

  // Find unique QFX account IDs
  const qfxAccounts = [...new Set(transactions.map(t => t.account))];

  // Map each QFX account to an Actual account ID
  const accountMapping = new Map<string, string>();
  for (const qfxAcct of qfxAccounts) {
    const txCount = transactions.filter(t => t.account === qfxAcct).length;
    const choice = await select({
      message: `Map QFX account "${qfxAcct}" (${txCount} transactions) to:`,
      choices: accounts.map(a => ({ name: a.name, value: a.id })),
    });
    accountMapping.set(qfxAcct, choice);
  }

  // Get category IDs for mapping
  const categories = await actual.getCategories();
  const categoryIdByName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));

  // Build and import per account
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const [qfxAcct, actualAcctId] of accountMapping) {
    const acctTxs = transactions.filter(t => t.account === qfxAcct);

    const payload = acctTxs.map(tx => {
      const cleanPayee = payeeMap.get(tx.rawPayee);
      const categoryName = cleanPayee ? categoryMap.get(cleanPayee) : undefined;
      const categoryId = categoryName ? categoryIdByName.get(categoryName.toLowerCase()) : undefined;

      // Convert YYYYMMDD → YYYY-MM-DD
      const date = `${tx.date.slice(0, 4)}-${tx.date.slice(4, 6)}-${tx.date.slice(6, 8)}`;
      // Convert to milliunits (Actual stores as integer cents × 10)
      const amount = Math.round(tx.amount * 1000);

      return {
        date,
        amount,
        imported_id: tx.id,
        imported_payee: tx.rawPayee,
        ...(cleanPayee ? { payee_name: cleanPayee } : {}),
        ...(categoryId ? { category: categoryId } : {}),
      };
    });

    const result = await actual.addTransactions(actualAcctId, payload);
    totalAdded += result.added?.length ?? 0;
    totalUpdated += result.updated?.length ?? 0;
    console.log(chalk.green(`  ✓ ${acctTxs.length} transactions → account ${qfxAcct}`));
  }

  console.log(chalk.bold.green(`\n✓ Import complete: ${totalAdded} added, ${totalUpdated} updated`));
}

// ── Main end-of-session flow ──────────────────────────────────────────────────

export async function runEndOfSession(
  sessionRules: VettedRule[],
  transactions: RawTransaction[],
  payeeMap: Map<string, string>,
  categoryMap: Map<string, string>,
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
        if (rule.stage === 'pre') {
          console.log(
            `  ${chalk.dim('pre')}  ${chalk.yellow(rule.matchValue)} → ${chalk.cyan(rule.actionValue)}`
          );
        } else {
          console.log(
            `  ${chalk.dim('cat')}  ${chalk.cyan(rule.matchValue)} → ${chalk.magenta(rule.actionValue)}`
          );
        }
      }
      console.log('');

      const doCreate = await confirm({
        message: `Create these ${sessionRules.length} rules in Actual Budget?`,
        default: true,
      });
      if (doCreate) {
        await createRulesInActual(sessionRules, actual);
      }
    } else if (rulesAction === 'create') {
      await createRulesInActual(sessionRules, actual);
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
    await importTransactions(transactions, payeeMap, categoryMap, actual);
  }
}
