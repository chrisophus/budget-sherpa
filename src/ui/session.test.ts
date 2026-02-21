import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTxPayload, createRulesInActual, consolidateVettedRules } from './session.js';
import type { RawTransaction, VettedRule, LLMAdapter, ConsolidationSuggestion } from '../types.js';
import type { ActualClient } from '../actual/client.js';
import { VettedRuleStore } from '../rules/vetted.js';

function makeTx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    id: 'TX001',
    date: '20260115',
    amount: -199.00,
    rawPayee: 'AMAZON MKTPL 12345',
    account: 'ACCT001',
    ...overrides,
  };
}

const noTag = () => null;
const noCat = () => null;

describe('buildTxPayload', () => {
  it('converts amount from dollars to cents', () => {
    const tx = makeTx({ amount: -199.00 });
    const result = buildTxPayload(tx, new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(-19900);
  });

  it('converts positive amount correctly', () => {
    const result = buildTxPayload(makeTx({ amount: 1234.56 }), new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(123456);
  });

  it('rounds sub-cent amounts', () => {
    // Some banks emit amounts like -5.999 due to FX; should round to nearest cent
    const result = buildTxPayload(makeTx({ amount: -5.999 }), new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(-600);
  });

  it('rounds -0.005 boundary to effectively zero', () => {
    // -0.005 * 100 rounds to 0 or -0 depending on floating point;
    // either way Math.abs of the result is 0.
    const result = buildTxPayload(makeTx({ amount: -0.005 }), new Map(), noTag, noCat, new Map());
    expect(Math.abs(result.amount as number)).toBe(0);
  });

  it('converts date from YYYYMMDD to YYYY-MM-DD', () => {
    const result = buildTxPayload(makeTx({ date: '20260315' }), new Map(), noTag, noCat, new Map());
    expect(result.date).toBe('2026-03-15');
  });

  it('sets payee_name when cleanPayee is found', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const result = buildTxPayload(makeTx(), payeeMap, noTag, noCat, new Map());
    expect(result.payee_name).toBe('Amazon');
  });

  it('omits payee_name when no mapping exists', () => {
    const result = buildTxPayload(makeTx(), new Map(), noTag, noCat, new Map());
    expect(result).not.toHaveProperty('payee_name');
  });

  it('sets category when lookup returns a known category', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const categoryLookup = (p: string) => p === 'Amazon' ? 'Shopping' : null;
    const categoryIdByName = new Map([['shopping', 'cat-123']]);
    const result = buildTxPayload(makeTx(), payeeMap, noTag, categoryLookup, categoryIdByName);
    expect(result.category).toBe('cat-123');
  });

  it('omits category when category name not found in Actual', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const categoryLookup = () => 'Shopping';
    const result = buildTxPayload(makeTx(), payeeMap, noTag, categoryLookup, new Map()); // empty id map
    expect(result).not.toHaveProperty('category');
  });

  it('sets notes tag when tagLookup returns a value', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const tagLookup = (p: string) => p === 'Amazon' ? 'discretionary' : null;
    const result = buildTxPayload(makeTx(), payeeMap, tagLookup, noCat, new Map());
    expect(result.notes).toBe('#discretionary');
  });

  it('omits notes when no tag', () => {
    const result = buildTxPayload(makeTx(), new Map(), noTag, noCat, new Map());
    expect(result).not.toHaveProperty('notes');
  });

  it('always sets imported_id and imported_payee', () => {
    const result = buildTxPayload(makeTx({ id: 'FIT123', rawPayee: 'WALMART' }), new Map(), noTag, noCat, new Map());
    expect(result.imported_id).toBe('FIT123');
    expect(result.imported_payee).toBe('WALMART');
  });
});

// ── createRulesInActual ───────────────────────────────────────────────────────

function makePreRule(matchValue: string, actionValue: string): VettedRule {
  return {
    key: `pre:imported_payee:contains:${matchValue}:payee:${actionValue}`,
    stage: 'pre', matchField: 'imported_payee', matchOp: 'contains',
    matchValue, actionField: 'payee', actionValue,
    vettedAt: new Date().toISOString(),
  };
}

function makeCatRule(matchValue: string, actionValue: string): VettedRule {
  return {
    key: `null:payee:is:${matchValue}:category:${actionValue}`,
    stage: null, matchField: 'payee', matchOp: 'is',
    matchValue, actionField: 'category', actionValue,
    vettedAt: new Date().toISOString(),
  };
}

function mockActual(opts: {
  payees?: Array<{ id: string; name: string; transfer_acct?: string }>;
  categories?: Array<{ id: string; name: string; group_id: string }>;
} = {}): ActualClient {
  return {
    getPayees:   vi.fn().mockResolvedValue(opts.payees   ?? []),
    getCategories: vi.fn().mockResolvedValue(opts.categories ?? []),
    createPayee: vi.fn().mockImplementation(async (name: string) => `payee-${name}`),
    createRule:  vi.fn().mockResolvedValue('rule-1'),
  } as unknown as ActualClient;
}

describe('createRulesInActual', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('creates a payee when not found, then creates the pre-stage rule', async () => {
    const actual = mockActual();
    await createRulesInActual([makePreRule('AMAZON', 'Amazon')], () => null, actual);
    expect(actual.createPayee).toHaveBeenCalledWith('Amazon');
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'pre',
      conditions: [expect.objectContaining({ op: 'contains', value: 'AMAZON' })],
      actions: [expect.objectContaining({ field: 'payee', value: 'payee-Amazon' })],
    }));
  });

  it('reuses existing payee instead of creating a new one', async () => {
    const actual = mockActual({ payees: [{ id: 'existing-id', name: 'Amazon' }] });
    await createRulesInActual([makePreRule('AMAZON', 'Amazon')], () => null, actual);
    expect(actual.createPayee).not.toHaveBeenCalled();
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({
      actions: [expect.objectContaining({ value: 'existing-id' })],
    }));
  });

  it('creates category rule using payee ID from pass 1', async () => {
    const actual = mockActual({
      categories: [{ id: 'cat-shopping', name: 'Shopping', group_id: 'g1' }],
    });
    const rules = [makePreRule('AMAZON', 'Amazon'), makeCatRule('Amazon', 'Shopping')];
    await createRulesInActual(rules, () => null, actual);

    // Two rule calls: one pre, one category
    expect(actual.createRule).toHaveBeenCalledTimes(2);
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({
      stage: null,
      conditions: [expect.objectContaining({ field: 'payee', value: 'payee-Amazon' })],
      actions: [expect.objectContaining({ field: 'category', value: 'cat-shopping' })],
    }));
  });

  it('skips category rule when payee is not found', async () => {
    const actual = mockActual({
      categories: [{ id: 'cat-shopping', name: 'Shopping', group_id: 'g1' }],
    });
    // Only category rule, no pre-rule to create the payee
    await createRulesInActual([makeCatRule('Amazon', 'Shopping')], () => null, actual);
    expect(actual.createRule).not.toHaveBeenCalled();
  });

  it('skips category rule when category is not found in Actual', async () => {
    const actual = mockActual({ categories: [] }); // no categories
    const rules = [makePreRule('AMAZON', 'Amazon'), makeCatRule('Amazon', 'Shopping')];
    await createRulesInActual(rules, () => null, actual);
    // Only pre-stage rule should be created
    expect(actual.createRule).toHaveBeenCalledTimes(1);
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pre' }));
  });

  it('dry-run: does not call actual.createRule', async () => {
    const actual = mockActual({
      categories: [{ id: 'cat-shopping', name: 'Shopping', group_id: 'g1' }],
    });
    const rules = [makePreRule('AMAZON', 'Amazon'), makeCatRule('Amazon', 'Shopping')];
    await createRulesInActual(rules, () => null, actual, /* dryRun= */ true);
    expect(actual.createRule).not.toHaveBeenCalled();
  });

  it('skips pre-rule when actionValue matches a transfer payee name', async () => {
    // "Chase Checking" is both a payee rule target AND a transfer payee name
    const actual = mockActual({
      payees: [{ id: 'transfer-payee-id', name: 'Chase Checking', transfer_acct: 'acct-001' }],
    });
    await createRulesInActual([makePreRule('CHASE', 'Chase Checking')], () => null, actual);
    // Should NOT create a rule for a transfer payee
    expect(actual.createRule).not.toHaveBeenCalled();
  });

  it('does NOT create a tag rule when payee has a tag but no category rule', async () => {
    // Tag rules are created inside the category-rule loop; without a category rule,
    // no tag rule is emitted. This is documented as current behavior.
    const actual = mockActual({
      categories: [{ id: 'cat-food', name: 'Food', group_id: 'g1' }],
    });
    // Only a pre-rule, no category rule
    const rules = [makePreRule('STARBUCKS', 'Starbucks')];
    await createRulesInActual(rules, () => 'discretionary', actual);
    // Only one rule created (pre), no tag rule
    expect(actual.createRule).toHaveBeenCalledTimes(1);
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({ stage: 'pre' }));
  });

  it('creates an additional tag rule when payee has a tag', async () => {
    const actual = mockActual({
      categories: [{ id: 'cat-shopping', name: 'Shopping', group_id: 'g1' }],
    });
    const rules = [makePreRule('AMAZON', 'Amazon'), makeCatRule('Amazon', 'Shopping')];
    await createRulesInActual(rules, () => 'discretionary', actual);

    // Three rules: pre + category + tag
    expect(actual.createRule).toHaveBeenCalledTimes(3);
    expect(actual.createRule).toHaveBeenCalledWith(expect.objectContaining({
      actions: [expect.objectContaining({ op: 'append-notes', value: '#discretionary' })],
    }));
  });
});

// ── consolidateVettedRules ────────────────────────────────────────────────────

// Mock inquirer for consolidation tests (same pattern as browse.test.ts)
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input:  vi.fn(),
  confirm: vi.fn(),
}));

import { select } from '@inquirer/prompts';

function tmpStore() {
  const path = join(tmpdir(), `vetted-session-${Date.now()}.json`);
  const store = new VettedRuleStore(path);
  const cleanup = () => { if (existsSync(path)) unlinkSync(path); };
  return { store, cleanup };
}

function mockLlm(suggestions: ConsolidationSuggestion[]): LLMAdapter {
  return {
    proposePayee:         vi.fn(),
    proposeCategory:      vi.fn(),
    reviewGroupings:      vi.fn(),
    suggestConsolidation: vi.fn().mockResolvedValue(suggestions),
  } as unknown as LLMAdapter;
}

function seedPreRule(store: VettedRuleStore, matchValue: string, actionValue: string) {
  store.approve({
    key: `pre:imported_payee:contains:${matchValue}:payee:${actionValue}`,
    stage: 'pre', matchField: 'imported_payee', matchOp: 'contains',
    matchValue, actionField: 'payee', actionValue,
    vettedAt: new Date().toISOString(),
  });
}

describe('consolidateVettedRules', () => {
  beforeEach(() => {
    vi.mocked(select).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when all payees have only one rule', async () => {
    const { store, cleanup } = tmpStore();
    try {
      seedPreRule(store, 'AMAZON MKTPL', 'Amazon');
      const llm = mockLlm([]);
      await consolidateVettedRules(store, llm);
      expect(llm.suggestConsolidation).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('accepts suggested consolidation and replaces old rules with one', async () => {
    const { store, cleanup } = tmpStore();
    try {
      seedPreRule(store, 'CAPITAL ONE CRCARDPMT 43FA', 'Capital One Credit Card Payment');
      seedPreRule(store, 'CAPITAL ONE CRCARDPMT 43S6', 'Capital One Credit Card Payment');

      const llm = mockLlm([{
        actionValue: 'Capital One Credit Card Payment',
        suggestedMatchValue: 'CAPITAL ONE CRCARDPMT',
        reason: 'Shares a common prefix',
      }]);

      vi.mocked(select).mockResolvedValue('accept');
      await consolidateVettedRules(store, llm);

      const preRules = store.getAllRules().filter(r => r.stage === 'pre');
      expect(preRules).toHaveLength(1);
      expect(preRules[0].matchValue).toBe('CAPITAL ONE CRCARDPMT');
      expect(preRules[0].actionValue).toBe('Capital One Credit Card Payment');
    } finally { cleanup(); }
  });

  it('skips when user chooses skip', async () => {
    const { store, cleanup } = tmpStore();
    try {
      seedPreRule(store, 'PAYPAL INST XFER 1234', 'PayPal');
      seedPreRule(store, 'PAYPAL INST XFER 5678', 'PayPal');

      const llm = mockLlm([{
        actionValue: 'PayPal',
        suggestedMatchValue: 'PAYPAL INST XFER',
        reason: 'Shared prefix',
      }]);

      vi.mocked(select).mockResolvedValue('skip');
      await consolidateVettedRules(store, llm);

      // Old rules unchanged
      expect(store.getAllRules().filter(r => r.stage === 'pre')).toHaveLength(2);
    } finally { cleanup(); }
  });

  it('allows editing the suggested pattern', async () => {
    const { store, cleanup } = tmpStore();
    try {
      seedPreRule(store, 'PAYPAL INST XFER 1234', 'PayPal');
      seedPreRule(store, 'PAYPAL INST XFER 5678', 'PayPal');

      const { input: mockInput } = await import('@inquirer/prompts') as any;

      const llm = mockLlm([{
        actionValue: 'PayPal',
        suggestedMatchValue: 'PAYPAL INST XFER',
        reason: 'Shared prefix',
      }]);

      vi.mocked(select).mockResolvedValue('edit');
      mockInput.mockResolvedValue('PAYPAL');

      await consolidateVettedRules(store, llm);

      const preRules = store.getAllRules().filter(r => r.stage === 'pre');
      expect(preRules).toHaveLength(1);
      expect(preRules[0].matchValue).toBe('PAYPAL');
    } finally { cleanup(); }
  });

  it('sends only groups with 2+ rules to the LLM', async () => {
    const { store, cleanup } = tmpStore();
    try {
      // Amazon: 2 rules (consolidation candidate)
      seedPreRule(store, 'AMAZON MKTPL 1234', 'Amazon');
      seedPreRule(store, 'AMAZON COM 5678', 'Amazon');
      // Netflix: 1 rule (not a candidate)
      seedPreRule(store, 'NETFLIX', 'Netflix');

      const llm = mockLlm([]);
      vi.mocked(select).mockResolvedValue('skip');
      await consolidateVettedRules(store, llm);

      expect(llm.suggestConsolidation).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ actionValue: 'Amazon', matchValues: expect.arrayContaining(['AMAZON MKTPL 1234', 'AMAZON COM 5678']) }),
        ]),
      );
      // Netflix should NOT be in the call
      expect(llm.suggestConsolidation).toHaveBeenCalledWith(
        expect.not.arrayContaining([
          expect.objectContaining({ actionValue: 'Netflix' }),
        ]),
      );
    } finally { cleanup(); }
  });
});
