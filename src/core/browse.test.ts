import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VettedRuleStore } from '../rules/vetted.js';
import type { VettedRule, Rule, RawTransaction, Suggestion } from '../types.js';
import {
  computeVettedMeta,
  buildProposedMeta,
  buildPayeeRows,
  aggregateGroupsForReview,
  applySuggestionMutation,
  type PayeeRow,
  type RawMeta,
} from './browse.js';

function tmpPath() {
  return join(tmpdir(), `core-browse-test-${Date.now()}.json`);
}

function makeVettedRule(overrides: Partial<VettedRule> = {}): VettedRule {
  return {
    key: 'pre:imported_payee:contains:AMAZON:payee:Amazon',
    stage: 'pre',
    matchField: 'imported_payee',
    matchOp: 'contains',
    matchValue: 'AMAZON',
    actionField: 'payee',
    actionValue: 'Amazon',
    vettedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTx(rawPayee: string, account = 'acct1'): RawTransaction {
  return { id: 'tx1', date: '20260101', amount: -10, rawPayee, account };
}

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ op: 'contains', field: 'imported_payee', value: 'AMAZON', type: 'string' }],
    actions: [{ op: 'set', field: 'payee', value: 'payee-id-amazon', type: 'id' }],
    ...overrides,
  };
}

function makeRow(overrides: Partial<PayeeRow> = {}): PayeeRow {
  return {
    rawPayees: ['RAW PAYEE 1'],
    txCount: 2,
    matchValue: 'RAW PAYEE',
    cleanPayee: 'Clean Name',
    category: null,
    tag: null,
    tagDecided: false,
    preRuleKey: 'pre:imported_payee:contains:RAW PAYEE:payee:Clean Name',
    wasVetted: false,
    touched: false,
    skipped: false,
    ...overrides,
  };
}

describe('computeVettedMeta', () => {
  let path: string;
  let vetted: VettedRuleStore;

  beforeEach(() => {
    path = tmpPath();
    vetted = new VettedRuleStore(path);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('returns stored meta with wasVetted=true when payee is already in the vetted store', () => {
    vetted.approve(makeVettedRule({
      key: 'pre:imported_payee:contains:AMAZON:payee:Amazon',
      matchValue: 'AMAZON',
      actionValue: 'Amazon',
    }));

    const result = computeVettedMeta('AMAZON MKTPL*XYZ', [makeTx('AMAZON MKTPL*XYZ')], [], vetted, new Map());

    expect(result).not.toBeNull();
    expect(result!.cleanPayee).toBe('Amazon');
    expect(result!.matchValue).toBe('AMAZON');
    expect(result!.wasVetted).toBe(true);
  });

  it('returns meta using rule payee name (no LLM) when an existing unvetted Actual rule matches', () => {
    const payeeById = new Map([['payee-id-amazon', 'Amazon']]);
    const rule = makeRule();
    const txs = [makeTx('AMAZON MKTPL*XYZ')];

    const result = computeVettedMeta('AMAZON MKTPL*XYZ', txs, [rule], vetted, payeeById);

    expect(result).not.toBeNull();
    expect(result!.cleanPayee).toBe('Amazon');
    expect(result!.matchValue).toBe('AMAZON');
    expect(result!.wasVetted).toBe(false);
  });

  it('returns null for an unknown payee with no rule and no vetted entry', () => {
    const result = computeVettedMeta('MYSTERY STORE 123', [makeTx('MYSTERY STORE 123')], [], vetted, new Map());
    expect(result).toBeNull();
  });
});

describe('buildProposedMeta', () => {
  it('derives matchValue via extractMatchValue and marks wasVetted=false', () => {
    const result = buildProposedMeta('AMAZON MKTPL*0C2091XO3', 'Amazon');

    expect(result.cleanPayee).toBe('Amazon');
    expect(result.matchValue).toBe('AMAZON MKTPL');
    expect(result.wasVetted).toBe(false);
    expect(result.preRuleKey).toBe('pre:imported_payee:contains:AMAZON MKTPL:payee:Amazon');
  });
});

describe('buildPayeeRows', () => {
  let path: string;
  let vetted: VettedRuleStore;

  beforeEach(() => {
    path = tmpPath();
    vetted = new VettedRuleStore(path);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('merges two raw payees sharing the same matchValue into one row', () => {
    const rawMetas = new Map<string, RawMeta>([
      ['AMAZON MKTPL*ABC', { matchValue: 'AMAZON MKTPL', cleanPayee: 'Amazon', preRuleKey: 'key1', wasVetted: false }],
      ['AMAZON MKTPL*XYZ', { matchValue: 'AMAZON MKTPL', cleanPayee: 'Amazon', preRuleKey: 'key1', wasVetted: false }],
    ]);
    const byRawPayee = new Map([
      ['AMAZON MKTPL*ABC', [makeTx('AMAZON MKTPL*ABC'), makeTx('AMAZON MKTPL*ABC')]],
      ['AMAZON MKTPL*XYZ', [makeTx('AMAZON MKTPL*XYZ')]],
    ]);

    const rows = buildPayeeRows(['AMAZON MKTPL*ABC', 'AMAZON MKTPL*XYZ'], rawMetas, byRawPayee, vetted);

    expect(rows.size).toBe(1);
    const row = rows.get('AMAZON MKTPL')!;
    expect(row.rawPayees).toHaveLength(2);
    expect(row.txCount).toBe(3);
    expect(row.cleanPayee).toBe('Amazon');
    expect(row.wasVetted).toBe(false);
  });

  it('sets wasVetted=true and populates category when payee has stored rules', () => {
    vetted.approve(makeVettedRule({
      key: 'pre:imported_payee:contains:COSTCO:payee:Costco',
      matchValue: 'COSTCO',
      actionValue: 'Costco',
    }));
    vetted.approve({
      key: 'null:payee:is:Costco:category:Groceries',
      stage: null,
      matchField: 'payee',
      matchOp: 'is',
      matchValue: 'Costco',
      actionField: 'category',
      actionValue: 'Groceries',
      vettedAt: '2026-01-01T00:00:00.000Z',
    });

    const rawMetas = new Map<string, RawMeta>([
      ['COSTCO WHSE #1234', { matchValue: 'COSTCO', cleanPayee: 'Costco', preRuleKey: 'pre:imported_payee:contains:COSTCO:payee:Costco', wasVetted: true }],
    ]);
    const byRawPayee = new Map([['COSTCO WHSE #1234', [makeTx('COSTCO WHSE #1234')]]]);

    const rows = buildPayeeRows(['COSTCO WHSE #1234'], rawMetas, byRawPayee, vetted);

    const row = rows.get('COSTCO')!;
    expect(row.wasVetted).toBe(true);
    expect(row.category).toBe('Groceries');
  });
});

describe('aggregateGroupsForReview', () => {
  it('merges two rows with the same cleanPayee into one group with combined rawPayees', () => {
    const rows = [
      makeRow({ cleanPayee: 'Amazon', matchValue: 'AMAZON MKTPL', rawPayees: ['AMAZON MKTPL*ABC'], category: 'Shopping' }),
      makeRow({ cleanPayee: 'Amazon', matchValue: 'AMAZON WEB', rawPayees: ['AMAZON WEB*123'], category: 'Shopping' }),
    ];

    const groups = aggregateGroupsForReview(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].cleanPayee).toBe('Amazon');
    expect(groups[0].rawPayees).toHaveLength(2);
    expect(groups[0].rawPayees).toContain('AMAZON MKTPL*ABC');
    expect(groups[0].rawPayees).toContain('AMAZON WEB*123');
  });

  it('keeps rows with distinct cleanPayees as separate groups', () => {
    const rows = [
      makeRow({ cleanPayee: 'Amazon', rawPayees: ['AMAZON MKTPL*ABC'] }),
      makeRow({ cleanPayee: 'Costco', matchValue: 'COSTCO', rawPayees: ['COSTCO WHSE #1234'], preRuleKey: 'key2' }),
    ];

    const groups = aggregateGroupsForReview(rows);

    expect(groups).toHaveLength(2);
    const names = groups.map(g => g.cleanPayee);
    expect(names).toContain('Amazon');
    expect(names).toContain('Costco');
  });
});

describe('applySuggestionMutation', () => {
  it('split — moves listed raw payees to a new row and reduces txCount on source', () => {
    const byRawPayee = new Map([
      ['AMAZON FRESH 001', [makeTx('AMAZON FRESH 001'), makeTx('AMAZON FRESH 001')]],
      ['AMAZON MKTPL*XYZ', [makeTx('AMAZON MKTPL*XYZ')]],
    ]);
    const rows: PayeeRow[] = [
      makeRow({
        cleanPayee: 'Amazon',
        rawPayees: ['AMAZON FRESH 001', 'AMAZON MKTPL*XYZ'],
        txCount: 3,
      }),
    ];

    const suggestion: Suggestion = {
      type: 'split',
      cleanPayee: 'Amazon',
      rawPayees: ['AMAZON FRESH 001'],
      suggestedName: 'Amazon Fresh',
      reason: 'Groceries vs shopping',
    };

    const result = applySuggestionMutation(suggestion, rows, byRawPayee);

    expect(result.applied).toBe(true);
    expect(result.newRow).toBeDefined();
    expect(result.newRow!.cleanPayee).toBe('Amazon Fresh');
    expect(result.newRow!.rawPayees).toEqual(['AMAZON FRESH 001']);
    expect(result.newRow!.txCount).toBe(2);
    // Source row should have the split payee removed
    expect(rows[0].rawPayees).toEqual(['AMAZON MKTPL*XYZ']);
    expect(rows[0].txCount).toBe(1);
    expect(rows[0].touched).toBe(true);
  });

  it('split — returns applied=false when none of the listed raw payees are found', () => {
    const rows: PayeeRow[] = [makeRow({ cleanPayee: 'Amazon', rawPayees: ['AMAZON MKTPL*XYZ'] })];

    const suggestion: Suggestion = {
      type: 'split',
      cleanPayee: 'Amazon',
      rawPayees: ['NONEXISTENT RAW PAYEE'],
      suggestedName: 'Nonexistent',
      reason: 'Test',
    };

    const result = applySuggestionMutation(suggestion, rows, new Map());

    expect(result.applied).toBe(false);
    expect(result.newRow).toBeUndefined();
  });

  it('rename — updates cleanPayee and preRuleKey on all matching rows', () => {
    const rows: PayeeRow[] = [
      makeRow({ cleanPayee: 'Gas Station', matchValue: 'SHELL', preRuleKey: 'pre:imported_payee:contains:SHELL:payee:Gas Station' }),
      makeRow({ cleanPayee: 'Gas Station', matchValue: 'CASEY', preRuleKey: 'pre:imported_payee:contains:CASEY:payee:Gas Station' }),
    ];

    const suggestion: Suggestion = {
      type: 'rename',
      cleanPayee: 'Gas Station',
      suggestedName: 'Shell',
      reason: 'Should use merchant name',
    };

    const result = applySuggestionMutation(suggestion, rows, new Map());

    expect(result.applied).toBe(true);
    expect(rows[0].cleanPayee).toBe('Shell');
    expect(rows[0].preRuleKey).toBe('pre:imported_payee:contains:SHELL:payee:Shell');
    expect(rows[1].cleanPayee).toBe('Shell');
    expect(rows[1].preRuleKey).toBe('pre:imported_payee:contains:CASEY:payee:Shell');
    expect(rows[0].touched).toBe(true);
    expect(rows[1].touched).toBe(true);
  });

  it('category — updates category on all matching rows', () => {
    const rows: PayeeRow[] = [
      makeRow({ cleanPayee: 'Netflix', category: null }),
    ];

    const suggestion: Suggestion = {
      type: 'category',
      cleanPayee: 'Netflix',
      suggestedCategory: 'Subscriptions',
      reason: 'Streaming service',
    };

    const result = applySuggestionMutation(suggestion, rows, new Map());

    expect(result.applied).toBe(true);
    expect(rows[0].category).toBe('Subscriptions');
    expect(rows[0].touched).toBe(true);
  });

  it('flag — returns applied=false with no state change', () => {
    const rows: PayeeRow[] = [makeRow({ cleanPayee: 'Bank Transfer' })];
    const originalCategory = rows[0].category;

    const suggestion: Suggestion = {
      type: 'flag',
      cleanPayee: 'Bank Transfer',
      reason: 'Looks like a transfer',
    };

    const result = applySuggestionMutation(suggestion, rows, new Map());

    expect(result.applied).toBe(false);
    expect(rows[0].category).toBe(originalCategory);
    expect(rows[0].touched).toBe(false);
  });
});
