import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { VettedRule, RawTransaction, LLMAdapter } from '../types.js';
import type { VettedRuleStore } from '../rules/vetted.js';
import type { ActualClient } from '../actual/client.js';
import { detectAndLinkTransfers } from './transfers.js';
import { TAG_CHOICES } from './constants.js';

// ── Edit session decisions ─────────────────────────────────────────────────────

async function editSessionDecisions(
  vetted: VettedRuleStore,
  payeeMap: Map<string, string>,
  categoryNames: string[],
): Promise<void> {
  while (true) {
    const sessionRules = vetted.getSessionRules();
    const preRules = sessionRules.filter(r => r.stage === 'pre');

    if (preRules.length === 0) {
      console.log('No session decisions to edit.');
      return;
    }

    // Build list of clean payees with their current decisions
    const choices = preRules.map(preRule => {
      const cleanPayee = preRule.actionValue;
      const catRule = sessionRules.find(r => r.stage === null && r.matchValue.toLowerCase() === cleanPayee.toLowerCase());
      const tag = vetted.hasTag(cleanPayee) ? vetted.getTag(cleanPayee) : undefined;

      let label = chalk.cyan(cleanPayee);
      if (catRule) label += '  ' + chalk.magenta(catRule.actionValue);
      if (tag) label += '  ' + chalk.dim(`#${tag}`);

      return { name: label, value: cleanPayee };
    });

    const chosen = await select({
      message: 'Select a payee to fix (or Done):',
      choices: [{ name: chalk.bold('Done'), value: '__done__' }, ...choices],
    });

    if (chosen === '__done__') return;

    const cleanPayee = chosen;
    const sr = vetted.getSessionRules();
    const preRule = sr.find(r => r.stage === 'pre' && r.actionValue.toLowerCase() === cleanPayee.toLowerCase());
    const catRule = sr.find(r => r.stage === null && r.matchValue.toLowerCase() === cleanPayee.toLowerCase());
    const currentTag = vetted.hasTag(cleanPayee) ? vetted.getTag(cleanPayee) : null;

    if (!preRule) continue;

    console.log(chalk.bold(`\n── ${cleanPayee} ──────────────────────────────`));
    console.log(`  ${chalk.dim('Match:')}    ${chalk.yellow(preRule.matchValue)}`);
    console.log(`  ${chalk.dim('Name:')}     ${chalk.cyan(cleanPayee)}`);
    console.log(`  ${chalk.dim('Category:')} ${catRule ? chalk.magenta(catRule.actionValue) : chalk.dim('(none)')}`);
    console.log(`  ${chalk.dim('Tag:')}      ${currentTag ? chalk.dim(`#${currentTag}`) : chalk.dim('(none)')}`);
    console.log('');

    const editAction = await select({
      message: 'Edit:',
      choices: [
        { name: 'Edit clean name', value: 'name' },
        { name: 'Edit category', value: 'category' },
        { name: 'Edit tag', value: 'tag' },
        { name: chalk.red('Remove all decisions for this payee'), value: 'remove' },
        { name: 'Back', value: 'back' },
      ],
    });

    if (editAction === 'back') continue;

    if (editAction === 'name') {
      const newName = (await input({ message: 'New clean name:', default: cleanPayee })).trim();
      if (newName === cleanPayee) { console.log(chalk.dim('Unchanged.')); continue; }

      // Re-key the pre-rule with the new name
      vetted.remove(preRule.key);
      vetted.approve({ ...preRule, actionValue: newName, key: `pre:imported_payee:contains:${preRule.matchValue}:payee:${newName}` });

      // Re-key the cat-rule (matchValue is the clean payee name)
      if (catRule) {
        vetted.remove(catRule.key);
        vetted.approve({ ...catRule, matchValue: newName, key: `null:payee:is:${newName}:category:${catRule.actionValue}` });
      }

      // Move the tag entry
      if (vetted.hasTag(cleanPayee)) {
        vetted.setTag(newName, vetted.getTag(cleanPayee));
        vetted.removeTag(cleanPayee);
      }

      // Update payeeMap: all rawPayees that mapped to the old clean name
      for (const [raw, name] of payeeMap) {
        if (name === cleanPayee) payeeMap.set(raw, newName);
      }

      console.log(chalk.green(`✓ Renamed "${cleanPayee}" → "${newName}"`));
    }

    if (editAction === 'category') {
      const newCategory = await select({
        message: 'Select category:',
        choices: [
          { name: chalk.dim('(none — remove category)'), value: '' },
          ...categoryNames.map(c => ({ name: c, value: c })),
        ],
      });

      if (catRule) vetted.remove(catRule.key);

      if (newCategory !== '') {
        vetted.approve({
          key: `null:payee:is:${cleanPayee}:category:${newCategory}`,
          stage: null,
          matchField: 'payee',
          matchOp: 'is',
          matchValue: cleanPayee,
          actionField: 'category',
          actionValue: newCategory,
          vettedAt: new Date().toISOString(),
        });
        console.log(chalk.green(`✓ Category → "${newCategory}"`));
      } else {
        console.log(chalk.yellow('✓ Category removed'));
      }
    }

    if (editAction === 'tag') {
      let tag = await select({
        message: `Tag "${cleanPayee}":`,
        choices: TAG_CHOICES,
      }) as string;

      if (tag === '__new__') {
        tag = (await input({ message: 'Tag name (without #):' })).trim().toLowerCase().replace(/\s+/g, '-');
      }

      vetted.setTag(cleanPayee, tag === '' ? null : tag);
      console.log(chalk.green(`✓ Tag → ${tag ? `#${tag}` : '(none)'}`));
    }

    if (editAction === 'remove') {
      vetted.remove(preRule.key);
      if (catRule) vetted.remove(catRule.key);
      if (vetted.hasTag(cleanPayee)) vetted.removeTag(cleanPayee);
      for (const [raw, name] of payeeMap) {
        if (name === cleanPayee) payeeMap.delete(raw);
      }
      console.log(chalk.yellow(`✓ Removed all decisions for "${cleanPayee}"`));
    }
  }
}

// ── Rule creation ─────────────────────────────────────────────────────────────

export async function createRulesInActual(
  rules: VettedRule[],
  tagLookup: (cleanPayee: string) => string | null,
  actual: ActualClient,
  dryRun = false,
): Promise<void> {
  const [rawPayees, categories] = await Promise.all([
    actual.getPayees() as Promise<Array<{ id: string; name: string; transfer_acct?: string }>>,
    actual.getCategories(),
  ]);

  // Exclude transfer payees (one per account, same name as the account) so rules never
  // accidentally resolve to them. A payee named "Chase Checking" matching the transfer
  // payee for the Chase Checking account would cause Actual Budget to auto-create a
  // mirror transaction on the other side, producing phantom credits/debits.
  const transferPayeeNames = new Set(
    rawPayees.filter(p => p.transfer_acct).map(p => p.name.toLowerCase()),
  );
  const payees = rawPayees.filter(p => !p.transfer_acct);
  const payeeByName = new Map(payees.map(p => [p.name.toLowerCase(), p.id]));
  const categoryByName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]));

  let created = 0;

  // Pass 1: pre-stage payee cleaning rules (may create new payees)
  for (const rule of rules.filter(r => r.stage === 'pre')) {
    if (transferPayeeNames.has(rule.actionValue.toLowerCase())) {
      console.log(chalk.yellow(`  ⚠ Skipping rule for "${rule.actionValue}" — matches an account name (transfer payee). Use transfer detection instead.`));
      continue;
    }
    let payeeId = payeeByName.get(rule.actionValue.toLowerCase());
    if (!payeeId) {
      payeeId = await actual.createPayee(rule.actionValue);
      payeeByName.set(rule.actionValue.toLowerCase(), payeeId);
    }
    if (dryRun) {
      console.log(chalk.dim(`  [dry-run] would create [pre] ${rule.matchValue} → ${rule.actionValue}`));
      created++;
      continue;
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

    if (dryRun) {
      console.log(chalk.dim(`  [dry-run] would create [cat] ${rule.matchValue} → ${rule.actionValue}`));
      created++;
    } else {
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
    }

    // Create a notes/tag rule if this payee has a tag
    const tag = tagLookup(rule.matchValue);
    if (tag) {
      if (dryRun) {
        console.log(chalk.dim(`  [dry-run] would create [tag] ${rule.matchValue} → #${tag}`));
        created++;
      } else {
        try {
          await actual.createRule({
            stage: null,
            conditionsOp: 'and',
            conditions: [condition],
            actions: [{ op: 'append-notes', field: 'notes', value: `#${tag}`, type: 'string' }],
          });
          created++;
          console.log(chalk.green(`  ✓ [tag] ${rule.matchValue} → #${tag}`));
        } catch (err: any) {
          console.log(chalk.red(`  ✗ [tag] ${rule.matchValue}: ${err.message ?? err}`));
        }
      }
    }
  }

  console.log(chalk.bold.green(`\n✓ Created ${created} rules in Actual Budget`));
}

// ── Transaction import ────────────────────────────────────────────────────────

// Exported for testing. Produces a minimal import payload — just factual data.
// Actual Budget's rules (created by budget-sherpa) handle payee cleaning,
// category assignment, and tag notes automatically during import.
export function buildTxPayload(tx: RawTransaction): Record<string, unknown> {
  // Convert YYYYMMDD → YYYY-MM-DD
  const date = `${tx.date.slice(0, 4)}-${tx.date.slice(4, 6)}-${tx.date.slice(6, 8)}`;
  // Convert dollars (float) to cents (integer) for Actual Budget
  const amount = Math.round(tx.amount * 100);
  return { date, amount, imported_id: tx.id, imported_payee: tx.rawPayee };
}

// Run a dry-run import against each account to show duplicate/new counts.
// Useful for validating readiness before the user imports through Actual's UI.
async function runDryRunValidation(
  transactions: RawTransaction[],
  accountMapping: Map<string, string>,
  actual: ActualClient,
): Promise<void> {
  console.log(chalk.bold('\n── Dry-Run Import Validation ────────────────'));
  for (const [qfxAcctId, actualAcctId] of accountMapping) {
    const payload = transactions
      .filter(t => t.account === qfxAcctId)
      .map(buildTxPayload);
    if (payload.length === 0) continue;
    try {
      const result = await actual.importTransactions(actualAcctId, payload, { dryRun: true });
      const newCount = result.added?.length ?? 0;
      const dupCount = result.updated?.length ?? 0;
      console.log(
        `  account …${qfxAcctId.slice(-4)}: ` +
        chalk.green(`${newCount} new`) +
        (dupCount > 0 ? chalk.dim(`, ${dupCount} already in Actual`) : ''),
      );
    } catch (err: any) {
      console.log(chalk.red(`  ✗ account ${qfxAcctId}: ${err.message ?? err}`));
    }
  }
}

// Import transactions using bare payloads — Actual's rules do the transformation.
async function importTransactions(
  transactions: RawTransaction[],
  accountMapping: Map<string, string>,
  actual: ActualClient,
  dryRun = false,
): Promise<void> {
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const [qfxAcctId, actualAcctId] of accountMapping) {
    const payload = transactions
      .filter(t => t.account === qfxAcctId)
      .map(buildTxPayload);

    if (dryRun) {
      console.log(chalk.dim(`  [dry-run] would import ${payload.length} transactions → account …${qfxAcctId.slice(-4)}`));
      totalAdded += payload.length;
      continue;
    }

    try {
      const result = await actual.importTransactions(actualAcctId, payload);
      const added = result.added?.length ?? 0;
      const dupes = result.updated?.length ?? 0;
      totalAdded += added;
      totalUpdated += dupes;
      const dupeNote = dupes > 0 ? chalk.dim(`, ${dupes} already existed`) : '';
      console.log(chalk.green(`  ✓ ${added} new transactions → account …${qfxAcctId.slice(-4)}${dupeNote}`));
      if (result.errors?.length) {
        for (const e of result.errors) console.log(chalk.red(`    error: ${JSON.stringify(e)}`));
      }
    } catch (err: any) {
      console.log(chalk.red(`  ✗ account ${qfxAcctId}: ${err.message ?? err}`));
    }
  }

  const dupesSummary = totalUpdated > 0 ? `, ${totalUpdated} duplicates skipped` : '';
  if (dryRun) {
    console.log(chalk.bold.yellow(`\n[dry-run] would import ${totalAdded} new transactions`));
  } else {
    console.log(chalk.bold.green(`\n✓ Import complete: ${totalAdded} new transactions${dupesSummary}`));
  }
}

// ── Rule consolidation ────────────────────────────────────────────────────────

// Exported for testing. Finds pre-stage rules that share an actionValue (same clean
// payee name) but have different matchValues, and asks the LLM to suggest a single
// consolidated match pattern for each group.
export async function consolidateVettedRules(
  vetted: VettedRuleStore,
  llm: LLMAdapter,
): Promise<void> {
  // Group pre-stage rules by actionValue (clean payee name)
  const allPreRules = vetted.getAllRules().filter(r => r.stage === 'pre');
  const byAction = new Map<string, VettedRule[]>();
  for (const rule of allPreRules) {
    const key = rule.actionValue.toLowerCase();
    if (!byAction.has(key)) byAction.set(key, []);
    byAction.get(key)!.push(rule);
  }

  // Only groups with 2+ distinct match patterns are consolidation candidates
  const groups = [...byAction.values()].filter(g => g.length > 1);

  if (groups.length === 0) {
    console.log(chalk.dim('  No consolidation candidates found.'));
    return;
  }

  console.log(chalk.dim(`  Found ${groups.length} payee(s) with multiple match patterns — asking AI for suggestions…`));

  const suggestions = await llm.suggestConsolidation(
    groups.map(g => ({ actionValue: g[0].actionValue, matchValues: g.map(r => r.matchValue) })),
  );

  if (suggestions.length === 0) {
    console.log(chalk.dim('  No consolidation suggestions returned.'));
    return;
  }

  for (const s of suggestions) {
    const group = groups.find(g => g[0].actionValue.toLowerCase() === s.actionValue.toLowerCase());
    if (!group) continue;

    console.log('');
    console.log(`${chalk.bold.cyan('[CONSOLIDATE]')}  ${chalk.bold(s.actionValue)}`);
    console.log(chalk.dim('  Current patterns:'));
    for (const rule of group) {
      console.log(chalk.dim(`    • ${rule.matchValue}`));
    }
    console.log(`  Suggested:  ${chalk.yellow(s.suggestedMatchValue)}`);
    console.log(chalk.dim('  ' + s.reason));

    const action = await select({
      message: 'Consolidate?',
      choices: [
        { name: `Accept: "${s.suggestedMatchValue}"`, value: 'accept' },
        { name: 'Edit pattern', value: 'edit' },
        { name: 'Skip', value: 'skip' },
      ],
    });

    if (action === 'skip') continue;

    let matchValue = s.suggestedMatchValue;
    if (action === 'edit') {
      matchValue = (await input({ message: 'Match pattern (contains):', default: matchValue })).trim();
    }

    // Remove the old per-variant rules
    for (const rule of group) {
      vetted.remove(rule.key);
    }

    // Save one consolidated rule (reuse the first rule's metadata as a template)
    const template = group[0];
    const newKey = `pre:imported_payee:contains:${matchValue}:payee:${template.actionValue}`;
    vetted.approve({
      key: newKey,
      stage: 'pre',
      matchField: 'imported_payee',
      matchOp: 'contains',
      matchValue,
      actionField: 'payee',
      actionValue: template.actionValue,
      vettedAt: new Date().toISOString(),
    });

    console.log(chalk.green(`  ✓ Consolidated ${group.length} rules → "${matchValue}" → "${template.actionValue}"`));
  }
}

// ── Main end-of-session flow ──────────────────────────────────────────────────

export async function runEndOfSession(
  vetted: VettedRuleStore,
  transactions: RawTransaction[],
  payeeMap: Map<string, string>,
  tagLookup: (cleanPayee: string) => string | null,
  accountMapping: Map<string, string>,
  actual: ActualClient,
  skipTransferDetection = false,
  dryRun = false,
  importMode = false,
  llm?: LLMAdapter,
): Promise<void> {
  if (dryRun) {
    console.log(chalk.bold.yellow('\n[DRY RUN — no changes will be made to Actual Budget]'));
  }
  console.log('\n' + chalk.bold('── End of Session ───────────────────────────'));

  // ── Review / fix decisions ─────────────────────────────────────────────────
  if (vetted.getSessionRules().some(r => r.stage === 'pre')) {
    console.log(chalk.bold('\n── Review Decisions ──────────────────────────'));
    const categories = await actual.getCategories();
    await editSessionDecisions(vetted, payeeMap, categories.map(c => c.name));
  }

  // ── Rule consolidation ─────────────────────────────────────────────────────
  if (llm) {
    const allPreRulesForCheck = vetted.getAllRules().filter(r => r.stage === 'pre');
    const actionCounts = new Map<string, number>();
    for (const r of allPreRulesForCheck) {
      actionCounts.set(r.actionValue.toLowerCase(), (actionCounts.get(r.actionValue.toLowerCase()) ?? 0) + 1);
    }
    const candidateCount = [...actionCounts.values()].filter(n => n > 1).length;

    if (candidateCount > 0) {
      console.log(chalk.bold('\n── Rule Consolidation ────────────────────────'));
      const runConsolidate = await confirm({
        message: `${candidateCount} payee(s) have multiple match patterns. Run AI consolidation?`,
        default: true,
      });
      if (runConsolidate) {
        await consolidateVettedRules(vetted, llm);
      }
    }
  }

  // Re-read after potential edits
  const sessionRules = vetted.getSessionRules();
  const allRules = vetted.getAllRules();

  // ── Create rules ───────────────────────────────────────────────────────────
  const allPreRules = allRules.filter(r => r.stage === 'pre');
  const allCatRules = allRules.filter(r => r.stage === null);

  const newSuffix = sessionRules.length > 0
    ? chalk.dim(` (${sessionRules.length} new this session)`)
    : '';
  console.log(`\n${chalk.bold(allRules.length)} vetted rules: ${allPreRules.length} payee, ${allCatRules.length} category${newSuffix}`);

  if (allRules.length > 0) {
    const rulesAction = await select({
      message: 'What would you like to do with the vetted rules?',
      choices: [
        { name: `Review ${sessionRules.length > 0 ? sessionRules.length + ' new' : allRules.length} rules`, value: 'review' },
        { name: `Create all ${allRules.length} rules in Actual Budget`, value: 'create' },
        { name: 'Skip', value: 'skip' },
      ],
    });

    if (rulesAction === 'review') {
      const toShow = sessionRules.length > 0 ? sessionRules : allRules;
      console.log('');
      for (const rule of toShow) {
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
        message: `Create all ${allRules.length} rules in Actual Budget?`,
        default: true,
      });
      if (doCreate) {
        await createRulesInActual(allRules, tagLookup, actual, dryRun);
      }
    } else if (rulesAction === 'create') {
      await createRulesInActual(allRules, tagLookup, actual, dryRun);
    }
  } else {
    console.log('No vetted rules yet.');
  }

  // ── Dry-run import validation (always available, not just in --import mode) ─
  // Lets the user preview what the import would look like before doing it
  // through Actual's UI or via --import, without committing any transactions.
  if (!dryRun && accountMapping.size > 0) {
    const runValidation = await confirm({
      message: `Run dry-run import to preview new vs. duplicate transaction counts?`,
      default: false,
    });
    if (runValidation) {
      await runDryRunValidation(transactions, accountMapping, actual);
    }
  }

  // ── Transaction import (--import mode only) ────────────────────────────────
  if (importMode) {
    const doImport = await confirm({
      message: `Import ${transactions.length} transactions into Actual Budget?`,
      default: true,
    });

    if (doImport) {
      await importTransactions(transactions, accountMapping, actual, dryRun);

      if (!dryRun) {
        // Flush before transfer detection so each sync POST stays small.
        await actual.sync();

        if (!skipTransferDetection) {
          const allAccounts = await actual.getAccounts() as Array<{ id: string; name: string }>;
          if (allAccounts.length > 1) {
            console.log('\n' + chalk.bold('── Transfer Detection ───────────────────────'));
            await detectAndLinkTransfers(allAccounts.map(a => a.id), actual);
          }
        }
      }
    }
  } else {
    console.log(chalk.dim('\nTip: run with --import to import transactions directly from budget-sherpa.'));
    console.log(chalk.dim('     Otherwise, import through Actual\'s UI — your rules will handle the rest.'));
  }
}
