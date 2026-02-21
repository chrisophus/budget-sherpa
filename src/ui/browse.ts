import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Rule, RawTransaction, VettedRule, LLMAdapter, Suggestion } from '../types.js';
import type { VettedRuleStore } from '../rules/vetted.js';
import { findPreRule, ruleKey } from '../rules/engine.js';
import { extractMatchValue } from '../rules/normalize.js';
import { TAG_CHOICES } from './constants.js';

// Run fn over items with at most `concurrency` in-flight at once.
export async function withConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (queue.length > 0) await fn(queue.shift()!);
    }),
  );
}

const LLM_CONCURRENCY = 5;

export interface PayeeRow {
  rawPayees: string[];      // raw payees covered by this match pattern
  txCount: number;
  matchValue: string;       // match pattern used in the pre-rule
  cleanPayee: string;       // current clean name decision
  category: string | null;  // current category decision
  tag: string | null;       // current tag (null = none)
  tagDecided: boolean;      // user has explicitly decided tag
  preRuleKey: string;       // key for the pre-rule
  wasVetted: boolean;       // already in vetted store from a previous session
  touched: boolean;         // user explicitly edited this row this session
  skipped: boolean;         // user chose Skip
}

function rowLabel(row: PayeeRow): string {
  const match = row.matchValue.slice(0, 26).padEnd(26);
  const name  = row.cleanPayee.slice(0, 20).padEnd(20);
  const cat   = (row.category ?? '').slice(0, 22).padEnd(22);
  const tag   = row.tagDecided && row.tag ? chalk.dim(`#${row.tag}`) : '     ';
  const count = chalk.dim(`(${row.txCount})`);
  const body  = `${chalk.yellow(match)}  ${chalk.cyan(name)}  ${chalk.magenta(cat)}  ${tag} ${count}`;
  if (row.skipped)  return chalk.dim('✗ ') + chalk.dim(body);
  if (row.touched)  return chalk.green('✎ ') + body;
  if (row.wasVetted) return chalk.dim('· ') + chalk.dim(body);
  return '  ' + body;
}

export async function applySuggestions(
  suggestions: Suggestion[],
  rows: PayeeRow[],
  byRawPayee: Map<string, RawTransaction[]>,
): Promise<void> {
  console.log(chalk.bold(`\n── AI Review: ${suggestions.length} suggestion(s) ─────────────────`));

  for (const s of suggestions) {
    // All rows sharing this clean payee name
    const matchingRows = rows.filter(r => r.cleanPayee.toLowerCase() === s.cleanPayee.toLowerCase());
    if (matchingRows.length === 0) continue;

    console.log('');

    const typeLabel: Record<string, string> = {
      split:    chalk.yellow('[SPLIT]'),
      rename:   chalk.blue('[RENAME]'),
      category: chalk.magenta('[CATEGORY]'),
      flag:     chalk.red('[FLAG]'),
    };
    console.log(`${typeLabel[s.type] ?? s.type}  ${chalk.bold(s.cleanPayee)}`);
    console.log(chalk.dim('  ' + s.reason));

    if (s.type === 'split' && s.rawPayees?.length) {
      console.log(chalk.dim('  Split off: ') + s.rawPayees.join(', '));
      if (s.suggestedName)     console.log(chalk.dim('  New name:  ') + chalk.cyan(s.suggestedName));
      if (s.suggestedCategory) console.log(chalk.dim('  Category:  ') + chalk.magenta(s.suggestedCategory));
    }
    if (s.type === 'rename' && s.suggestedName)
      console.log(chalk.dim('  Rename to: ') + chalk.cyan(s.suggestedName));
    if (s.type === 'category' && s.suggestedCategory)
      console.log(chalk.dim('  Category:  ') + chalk.magenta(s.suggestedCategory));

    const action = await select({
      message: 'Accept?',
      choices: [
        { name: 'Accept', value: 'accept' },
        { name: 'Skip', value: 'skip' },
      ],
    });

    if (action !== 'accept') continue;

    if (s.type === 'split' && s.rawPayees?.length && s.suggestedName) {
      const toSplit = new Set(s.rawPayees.map(r => r.toLowerCase()));
      const removed: string[] = [];

      // Raw payees can live in any row sharing this clean name — search all of them
      for (const row of matchingRows) {
        const taken = row.rawPayees.filter(r => toSplit.has(r.toLowerCase()));
        if (taken.length === 0) continue;
        removed.push(...taken);
        row.rawPayees = row.rawPayees.filter(r => !toSplit.has(r.toLowerCase()));
        row.txCount = row.rawPayees.reduce((n, r) => n + (byRawPayee.get(r)?.length ?? 0), 0);
        row.touched = true;
      }

      if (removed.length === 0) { console.log(chalk.yellow('  ⚠ None of the listed raw payees found — skipped')); continue; }

      const newMatchValue = extractMatchValue(removed[0]);
      rows.push({
        rawPayees: removed,
        txCount: removed.reduce((n, r) => n + (byRawPayee.get(r)?.length ?? 0), 0),
        matchValue: newMatchValue,
        cleanPayee: s.suggestedName,
        category: s.suggestedCategory ?? null,
        tag: null,
        tagDecided: false,
        preRuleKey: `pre:imported_payee:contains:${newMatchValue}:payee:${s.suggestedName}`,
        wasVetted: false,
        touched: true,
        skipped: false,
      });
      console.log(chalk.green(`  ✓ Split off ${removed.length} raw payee(s) → "${s.suggestedName}"`));
    }

    if (s.type === 'rename' && s.suggestedName) {
      const old = matchingRows[0].cleanPayee;
      for (const row of matchingRows) {
        row.cleanPayee = s.suggestedName;
        row.preRuleKey = `pre:imported_payee:contains:${row.matchValue}:payee:${s.suggestedName}`;
        row.touched = true;
      }
      console.log(chalk.green(`  ✓ Renamed "${old}" → "${s.suggestedName}" (${matchingRows.length} row(s))`));
    }

    if (s.type === 'category' && s.suggestedCategory) {
      for (const row of matchingRows) {
        row.category = s.suggestedCategory;
        row.touched = true;
      }
      console.log(chalk.green(`  ✓ Category → "${s.suggestedCategory}" (${matchingRows.length} row(s))`));
    }

    // 'flag' type: no automatic change, just shown for awareness
  }
}

// Exported for testing. Persists row decisions to the vetted store and
// returns rawPayee → cleanPayee mapping.
export function saveDecisions(
  rows: PayeeRow[],
  vetted: VettedRuleStore,
  knownPayeeNames: string[],
): Map<string, string> {
  const payeeMap = new Map<string, string>();

  for (const row of rows) {
    if (row.skipped) continue;

    // A split may have moved all raw payees out of this row — clean up its
    // old rule so those payees don't re-join this group on the next run.
    if (row.rawPayees.length === 0) {
      const stale = vetted.getAllRules().find(r => r.stage === 'pre' && r.matchValue === row.matchValue);
      if (stale) vetted.remove(stale.key);
      continue;
    }

    for (const raw of row.rawPayees) {
      payeeMap.set(raw, row.cleanPayee);
    }
    if (!knownPayeeNames.includes(row.cleanPayee)) knownPayeeNames.push(row.cleanPayee);

    // Save to store only for new payees or ones the user explicitly touched
    if (row.wasVetted && !row.touched) continue;

    // Remove any stale pre-rule for this matchValue (e.g. from a rename) so
    // the old cleanPayee name doesn't persist alongside the new one.
    const stalePreRule = vetted.getAllRules().find(
      r => r.stage === 'pre' && r.matchValue === row.matchValue && r.key !== row.preRuleKey,
    );
    if (stalePreRule) vetted.remove(stalePreRule.key);

    vetted.approve({
      key: row.preRuleKey,
      stage: 'pre',
      matchField: 'imported_payee',
      matchOp: 'contains',
      matchValue: row.matchValue,
      actionField: 'payee',
      actionValue: row.cleanPayee,
      vettedAt: new Date().toISOString(),
    });

    if (row.category !== null) {
      vetted.approve({
        key: `null:payee:is:${row.cleanPayee}:category:${row.category}`,
        stage: null,
        matchField: 'payee',
        matchOp: 'is',
        matchValue: row.cleanPayee,
        actionField: 'category',
        actionValue: row.category,
        vettedAt: new Date().toISOString(),
      });
    }

    if (row.tagDecided) {
      vetted.setTag(row.cleanPayee, row.tag);
    }
  }

  return payeeMap;
}

export async function browseAndVet(
  uniqueRawPayees: string[],
  byRawPayee: Map<string, RawTransaction[]>,
  rules: Rule[],
  vetted: VettedRuleStore,
  llm: LLMAdapter,
  knownPayeeNames: string[],
  categoryNames: string[],
  payeeById: Map<string, string>,
): Promise<{ payeeMap: Map<string, string>; quit: boolean }> {

  // ── Phase 1: compute clean-name proposals in parallel ───────────────────────

  type RawMeta = { matchValue: string; cleanPayee: string; preRuleKey: string; wasVetted: boolean };
  const rawMeta = new Map<string, RawMeta>();

  let p1done = 0, p1vetted = 0, p1llm = 0, p1llmDone = 0;
  const p1total = uniqueRawPayees.length;

  // First pass: count how many need LLM calls (fast, no I/O)
  for (const rawPayee of uniqueRawPayees) {
    const txs = byRawPayee.get(rawPayee)!;
    const matchedRule = findPreRule(rules, txs[0]);
    const key = matchedRule ? ruleKey(matchedRule) : null;
    const needsLlm = !vetted.findPayeeRule(rawPayee) && !(key && vetted.isVetted(key));
    if (needsLlm) p1llm++;
  }

  const p1label = () => {
    const vetStr = chalk.dim(`${p1vetted} vetted`);
    const llmStr = chalk.dim(`${p1llmDone}/${p1llm} LLM`);
    return chalk.dim(`Computing clean names… ${p1done}/${p1total}  (${vetStr}, ${llmStr})`);
  };
  process.stdout.write('\n' + p1label());

  await withConcurrency(uniqueRawPayees, LLM_CONCURRENCY, async (rawPayee) => {
    const txs = byRawPayee.get(rawPayee)!;
    const matchedRule = findPreRule(rules, txs[0]);
    const key = matchedRule ? ruleKey(matchedRule) : null;

    const vettedByPayee = vetted.findPayeeRule(rawPayee);
    if (vettedByPayee) {
      rawMeta.set(rawPayee, { matchValue: vettedByPayee.matchValue, cleanPayee: vettedByPayee.actionValue, preRuleKey: vettedByPayee.key, wasVetted: true });
      p1vetted++;
    } else if (key && vetted.isVetted(key)) {
      const stored = vetted.get(key)!;
      rawMeta.set(rawPayee, { matchValue: stored.matchValue, cleanPayee: stored.actionValue, preRuleKey: key, wasVetted: true });
      p1vetted++;
    } else {
      const rawValue = matchedRule?.actions.find(a => a.field === 'payee')?.value ?? rawPayee;
      const resolvedValue = payeeById.get(rawValue) ?? rawValue;
      const matchValue = matchedRule
        ? (matchedRule.conditions.find(c => c.field === 'imported_payee')?.value ?? rawPayee)
        : extractMatchValue(rawPayee);
      const cleanPayee = matchedRule ? resolvedValue : await llm.proposePayee(rawPayee, knownPayeeNames);
      rawMeta.set(rawPayee, {
        matchValue,
        cleanPayee,
        preRuleKey: key ?? `pre:imported_payee:contains:${matchValue}:payee:${cleanPayee}`,
        wasVetted: false,
      });
      p1llmDone++;
    }

    p1done++;
    process.stdout.write('\r' + p1label());
  });
  process.stdout.write('\n');

  // ── Group by matchValue (one row = one pre-rule) ─────────────────────────────

  const rowsByMatch = new Map<string, PayeeRow>();
  for (const rawPayee of uniqueRawPayees) {
    const d = rawMeta.get(rawPayee)!;
    const existing = rowsByMatch.get(d.matchValue);
    if (existing) {
      existing.rawPayees.push(rawPayee);
      existing.txCount += byRawPayee.get(rawPayee)?.length ?? 0;
      continue;
    }
    const catRule = vetted.findCategoryRule(d.cleanPayee);
    rowsByMatch.set(d.matchValue, {
      rawPayees: [rawPayee],
      txCount: byRawPayee.get(rawPayee)?.length ?? 0,
      matchValue: d.matchValue,
      cleanPayee: d.cleanPayee,
      category: catRule?.actionValue ?? null,
      tag: vetted.hasTag(d.cleanPayee) ? vetted.getTag(d.cleanPayee) : null,
      tagDecided: vetted.hasTag(d.cleanPayee),
      preRuleKey: d.preRuleKey,
      wasVetted: d.wasVetted,
      touched: false,
      skipped: false,
    });
  }

  // ── Phase 2: category proposals for new rows (parallel) ─────────────────────

  const newRows = [...rowsByMatch.values()].filter(r => !r.wasVetted && r.category === null);
  let p2done = 0;
  const p2total = newRows.length;
  if (p2total > 0) {
    process.stdout.write(chalk.dim(`Computing categories… 0/${p2total}`));
    await withConcurrency(newRows, LLM_CONCURRENCY, async row => {
      row.category = (await llm.proposeCategory(row.cleanPayee, categoryNames)) || null;
      p2done++;
      process.stdout.write(`\r${chalk.dim(`Computing categories… ${p2done}/${p2total}`)}`);
    });
    process.stdout.write('\n');
  }

  const rows = [...rowsByMatch.values()].sort((a, b) => a.cleanPayee.localeCompare(b.cleanPayee));

  // ── Phase 2.5: AI grouping review (opt-in) ───────────────────────────────────

  const { confirm } = await import('@inquirer/prompts');
  const runReview = await confirm({
    message: `Run AI anomaly review? (checks all ${rows.length} groupings for issues)`,
    default: false,
  });

  if (runReview) {
    process.stdout.write(chalk.dim('Reviewing groupings for anomalies…'));
    // Aggregate rows by clean payee name so the LLM sees one entry per
    // logical payee with ALL raw strings — not separate entries per match pattern.
    const groupMap = new Map<string, { cleanPayee: string; category: string | null; rawPayees: string[] }>();
    for (const row of rows) {
      const key = row.cleanPayee.toLowerCase();
      if (!groupMap.has(key)) groupMap.set(key, { cleanPayee: row.cleanPayee, category: row.category, rawPayees: [] });
      groupMap.get(key)!.rawPayees.push(...row.rawPayees);
    }
    const groups = [...groupMap.values()];
    const suggestions = await llm.reviewGroupings(groups);
    process.stdout.write('\r' + chalk.dim(`Reviewing groupings for anomalies… ${suggestions.length} suggestion(s) found.\n`));

    if (suggestions.length > 0) {
      await applySuggestions(suggestions, rows, byRawPayee);
    } else {
      console.log(chalk.dim('No anomalies found.'));
    }
  }

  // ── Phase 3: browse loop ─────────────────────────────────────────────────────

  const newCount = rows.filter(r => !r.wasVetted).length;
  console.log(chalk.bold(`\n── ${rows.length} payees  (${newCount} new, ${rows.length - newCount} previously vetted) ─`));
  console.log(chalk.dim('  ✎ = edited this session   · = previously vetted   ✗ = skipped\n'));

  let quit = false;
  let lastChosen: string | undefined;

  while (true) {
    const choices = [
      { name: chalk.bold('Done — save decisions and create rules in Actual Budget'), value: '__done__' },
      { name: chalk.bold('Save decisions and quit (no Actual Budget changes yet)'), value: '__quit__' },
      ...rows.map((row, i) => ({ name: rowLabel(row), value: String(i) })),
    ];

    const chosen = await select({
      message: 'Select a payee to edit:',
      choices,
      pageSize: 20,
      default: lastChosen,
    });

    if (chosen === '__done__') break;
    if (chosen === '__quit__') { quit = true; break; }

    lastChosen = chosen;

    const row = rows[parseInt(chosen, 10)];
    row.touched = true;

    // Stage 1: clean name + match pattern
    console.log('\n' + chalk.bold('── Payee Rule ──────────────────────────────'));
    const shown = row.rawPayees.slice(0, 3).join(', ') + (row.rawPayees.length > 3 ? ` +${row.rawPayees.length - 3} more` : '');
    console.log(chalk.dim('Raw payee(s): ') + chalk.yellow(shown));
    console.log(chalk.dim('Occurrences:  ') + row.txCount);
    console.log(chalk.dim('Match:        ') + chalk.yellow(row.matchValue));
    console.log(chalk.dim('Clean name:   ') + chalk.cyan(row.cleanPayee));

    stage1: while (true) {
      const action = await select({
        message: 'Accept?',
        choices: [
          { name: `Accept "${row.cleanPayee}"`, value: 'accept' },
          { name: 'Edit name', value: 'edit-name' },
          { name: 'Edit match pattern', value: 'edit-match' },
          { name: 'Skip (no rule)', value: 'skip' },
        ],
      });

      if (action === 'skip') { row.skipped = true; break stage1; }

      if (action === 'edit-name') {
        row.cleanPayee = (await input({ message: 'Clean name:', default: row.cleanPayee })).trim();
        row.preRuleKey = `pre:imported_payee:contains:${row.matchValue}:payee:${row.cleanPayee}`;
        // Re-check if the new clean name already has a stored category
        const existingCat = vetted.findCategoryRule(row.cleanPayee);
        if (existingCat) row.category = existingCat.actionValue;
        console.log(chalk.dim('Clean name:   ') + chalk.cyan(row.cleanPayee));
        continue;
      }

      if (action === 'edit-match') {
        row.matchValue = (await input({ message: 'Match pattern (contains):', default: row.matchValue })).trim();
        row.preRuleKey = `pre:imported_payee:contains:${row.matchValue}:payee:${row.cleanPayee}`;
        console.log(chalk.dim('Match:        ') + chalk.yellow(row.matchValue));
        continue;
      }

      break stage1; // accept
    }

    if (row.skipped) continue;

    // Stage 2: category
    console.log(chalk.bold('── Category ────────────────────────────────'));
    console.log(chalk.dim('Proposed: ') + (row.category ? chalk.magenta(row.category) : chalk.dim('(none)')));

    const catAction = await select({
      message: 'Accept this category?',
      choices: [
        { name: row.category ? `Accept "${row.category}"` : 'Accept (none)', value: 'accept' },
        { name: 'Choose from list', value: 'choose' },
        { name: 'Skip (no category)', value: 'skip' },
      ],
    });

    if (catAction === 'choose') {
      row.category = await select({
        message: 'Select category:',
        choices: categoryNames.map(c => ({ name: c, value: c })),
      });
    } else if (catAction === 'skip') {
      row.category = null;
    }

    // Stage 3: tag
    let tag = await select({ message: `Tag "${row.cleanPayee}":`, choices: TAG_CHOICES }) as string;
    if (tag === '__new__') {
      tag = (await input({ message: 'Tag name (without #):' })).trim().toLowerCase().replace(/\s+/g, '-');
    }
    row.tag = tag === '' ? null : tag;
    row.tagDecided = true;

    console.log(chalk.green(`✓ "${row.cleanPayee}" — ${row.category ?? 'no category'}${row.tag ? ` #${row.tag}` : ''}`));
  }

  // ── Phase 4: save decisions to vetted store ──────────────────────────────────

  const payeeMap = saveDecisions(rows, vetted, knownPayeeNames);

  return { payeeMap, quit };
}
