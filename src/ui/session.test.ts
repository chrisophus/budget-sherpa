import { vi, describe, it, expect, beforeEach } from 'vitest';
import { buildTxPayload, createRulesInActual } from './session.js';
import type { RawTransaction, VettedRule } from '../types.js';
import type { ActualClient } from '../actual/client.js';

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
  payees?: Array<{ id: string; name: string }>;
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
