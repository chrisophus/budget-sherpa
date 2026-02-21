import type { Rule, RawTransaction, Suggestion, GroupForReview } from '../types.js';
import type { VettedRuleStore } from '../rules/vetted.js';
import { findPreRule, ruleKey } from '../rules/engine.js';
import { extractMatchValue } from '../rules/normalize.js';

export interface RawMeta {
  matchValue: string;
  cleanPayee: string;
  preRuleKey: string;
  wasVetted: boolean;
}

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

// Compute RawMeta for a payee without making an LLM call.
// Returns null when the payee is unknown and needs an LLM name proposal.
// Handles three non-LLM cases:
//   1. Already vetted via raw payee lookup (prior session)
//   2. Already vetted via Actual Budget rule key
//   3. Existing unvetted Actual rule — resolves payee name from payeeById
export function computeVettedMeta(
  rawPayee: string,
  txs: RawTransaction[],
  rules: Rule[],
  vetted: VettedRuleStore,
  payeeById: Map<string, string>,
): RawMeta | null {
  const matchedRule = findPreRule(rules, txs[0]);
  const key = matchedRule ? ruleKey(matchedRule) : null;

  // Case 1: vetted by raw payee (from a prior session)
  const vettedByPayee = vetted.findPayeeRule(rawPayee);
  if (vettedByPayee) {
    return {
      matchValue: vettedByPayee.matchValue,
      cleanPayee: vettedByPayee.actionValue,
      preRuleKey: vettedByPayee.key,
      wasVetted: true,
    };
  }

  // Case 2: vetted by Actual Budget rule key
  if (key && vetted.isVetted(key)) {
    const stored = vetted.get(key)!;
    return {
      matchValue: stored.matchValue,
      cleanPayee: stored.actionValue,
      preRuleKey: key,
      wasVetted: true,
    };
  }

  // Case 3: existing unvetted Actual rule — use rule's payee name, no LLM needed
  if (matchedRule) {
    const rawValue = matchedRule.actions.find(a => a.field === 'payee')?.value ?? rawPayee;
    const resolvedValue = payeeById.get(rawValue) ?? rawValue;
    const matchValue = matchedRule.conditions.find(c => c.field === 'imported_payee')?.value ?? rawPayee;
    return {
      matchValue,
      cleanPayee: resolvedValue,
      preRuleKey: key ?? `pre:imported_payee:contains:${matchValue}:payee:${resolvedValue}`,
      wasVetted: false,
    };
  }

  // Case 4: unknown payee — caller must obtain a proposed name (e.g. via LLM)
  return null;
}

// Build RawMeta for a payee whose name was obtained externally (e.g. from an LLM call).
// Only used when computeVettedMeta returned null.
export function buildProposedMeta(rawPayee: string, proposedName: string): RawMeta {
  const matchValue = extractMatchValue(rawPayee);
  return {
    matchValue,
    cleanPayee: proposedName,
    preRuleKey: `pre:imported_payee:contains:${matchValue}:payee:${proposedName}`,
    wasVetted: false,
  };
}

// Group raw payees by matchValue into PayeeRow objects.
// Multiple raw payees with the same match pattern share one row (one pre-rule).
export function buildPayeeRows(
  uniqueRawPayees: string[],
  rawMetas: Map<string, RawMeta>,
  byRawPayee: Map<string, RawTransaction[]>,
  vetted: VettedRuleStore,
): Map<string, PayeeRow> {
  const rowsByMatch = new Map<string, PayeeRow>();
  for (const rawPayee of uniqueRawPayees) {
    const d = rawMetas.get(rawPayee)!;
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
  return rowsByMatch;
}

// Aggregate rows by clean payee name for LLM batch review.
// Rows sharing the same clean payee name (different match patterns) are merged.
export function aggregateGroupsForReview(rows: PayeeRow[]): GroupForReview[] {
  const groupMap = new Map<string, { cleanPayee: string; category: string | null; rawPayees: string[] }>();
  for (const row of rows) {
    const key = row.cleanPayee.toLowerCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, { cleanPayee: row.cleanPayee, category: row.category, rawPayees: [] });
    }
    groupMap.get(key)!.rawPayees.push(...row.rawPayees);
  }
  return [...groupMap.values()];
}

// Apply the data mutation for one AI suggestion (split/rename/category).
// Mutates existing rows in-place via object references.
// For 'split': also returns the new row to push into the rows array (caller's responsibility).
// Returns applied=false for 'flag' type or when no matching raw payees are found.
export function applySuggestionMutation(
  suggestion: Suggestion,
  rows: PayeeRow[],
  byRawPayee: Map<string, RawTransaction[]>,
): { applied: boolean; newRow?: PayeeRow } {
  const matchingRows = rows.filter(r => r.cleanPayee.toLowerCase() === suggestion.cleanPayee.toLowerCase());

  if (suggestion.type === 'split' && suggestion.rawPayees?.length && suggestion.suggestedName) {
    const toSplit = new Set(suggestion.rawPayees.map(r => r.toLowerCase()));
    const removed: string[] = [];

    for (const row of matchingRows) {
      const taken = row.rawPayees.filter(r => toSplit.has(r.toLowerCase()));
      if (taken.length === 0) continue;
      removed.push(...taken);
      row.rawPayees = row.rawPayees.filter(r => !toSplit.has(r.toLowerCase()));
      row.txCount = row.rawPayees.reduce((n, r) => n + (byRawPayee.get(r)?.length ?? 0), 0);
      row.touched = true;
    }

    if (removed.length === 0) return { applied: false };

    const newMatchValue = extractMatchValue(removed[0]);
    const newRow: PayeeRow = {
      rawPayees: removed,
      txCount: removed.reduce((n, r) => n + (byRawPayee.get(r)?.length ?? 0), 0),
      matchValue: newMatchValue,
      cleanPayee: suggestion.suggestedName,
      category: suggestion.suggestedCategory ?? null,
      tag: null,
      tagDecided: false,
      preRuleKey: `pre:imported_payee:contains:${newMatchValue}:payee:${suggestion.suggestedName}`,
      wasVetted: false,
      touched: true,
      skipped: false,
    };
    return { applied: true, newRow };
  }

  if (suggestion.type === 'rename' && suggestion.suggestedName) {
    for (const row of matchingRows) {
      row.cleanPayee = suggestion.suggestedName;
      row.preRuleKey = `pre:imported_payee:contains:${row.matchValue}:payee:${suggestion.suggestedName}`;
      row.touched = true;
    }
    return { applied: matchingRows.length > 0 };
  }

  if (suggestion.type === 'category' && suggestion.suggestedCategory) {
    for (const row of matchingRows) {
      row.category = suggestion.suggestedCategory;
      row.touched = true;
    }
    return { applied: matchingRows.length > 0 };
  }

  // 'flag' type — display only, no state change
  return { applied: false };
}
