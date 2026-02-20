import { describe, it, expect } from 'vitest';
import { ruleKey, findPreRule, findCategoryRule } from './engine.js';
import type { Rule, RawTransaction } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function preRule(op: Rule['conditions'][0]['op'], value: string, actionPayeeId = 'p-1'): Rule {
  return {
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [{ op, field: 'imported_payee', value, type: 'string' }],
    actions: [{ op: 'set', field: 'payee', value: actionPayeeId, type: 'id' }],
  };
}

function catRule(op: Rule['conditions'][0]['op'], value: string, categoryId = 'c-1'): Rule {
  return {
    stage: null,
    conditionsOp: 'and',
    conditions: [{ op, field: 'payee', value, type: 'id' }],
    actions: [{ op: 'set', field: 'category', value: categoryId, type: 'id' }],
  };
}

function tx(rawPayee: string): RawTransaction {
  return { id: 'T1', date: '20260101', amount: -10, rawPayee, account: 'A1' };
}

// ── ruleKey ───────────────────────────────────────────────────────────────────

describe('ruleKey', () => {
  it('produces a stable key from rule content', () => {
    const rule = preRule('contains', 'AMAZON');
    expect(ruleKey(rule)).toBe('pre:imported_payee:contains:AMAZON:payee:p-1');
  });

  it('uses "null" for null stage', () => {
    const rule = catRule('is', 'Amazon');
    expect(ruleKey(rule)).toBe('null:payee:is:Amazon:category:c-1');
  });

  it('different conditions produce different keys', () => {
    expect(ruleKey(preRule('contains', 'AMAZON'))).not.toBe(ruleKey(preRule('contains', 'STARBUCKS')));
  });
});

// ── matchesCondition (via findPreRule) ────────────────────────────────────────

describe('condition operators', () => {
  it('contains — matches substring (case-insensitive)', () => {
    expect(findPreRule([preRule('contains', 'amazon')], tx('AMAZON MKTPL 123'))).not.toBeNull();
    expect(findPreRule([preRule('contains', 'AMAZON')], tx('amazon mktpl 123'))).not.toBeNull();
    expect(findPreRule([preRule('contains', 'amazon')], tx('STARBUCKS'))).toBeNull();
  });

  it('is — exact match (case-insensitive)', () => {
    expect(findPreRule([preRule('is', 'STARBUCKS')], tx('STARBUCKS'))).not.toBeNull();
    expect(findPreRule([preRule('is', 'starbucks')], tx('STARBUCKS'))).not.toBeNull();
    expect(findPreRule([preRule('is', 'STARBUCKS')], tx('STARBUCKS #123'))).toBeNull();
  });

  it('starts-with — prefix match (case-insensitive)', () => {
    expect(findPreRule([preRule('starts-with', 'TST*')], tx('TST* CHIRINGUITO'))).not.toBeNull();
    expect(findPreRule([preRule('starts-with', 'TST*')], tx('NOTST*'))).toBeNull();
  });

  it('ends-with — suffix match (case-insensitive)', () => {
    expect(findPreRule([preRule('ends-with', 'LLC')], tx('CHIRINGUITO LLC'))).not.toBeNull();
    expect(findPreRule([preRule('ends-with', 'LLC')], tx('LLC CHIRINGUITO'))).toBeNull();
  });

  it('matches — regex match', () => {
    expect(findPreRule([preRule('matches', 'AMAZON.*MKTPL')], tx('AMAZON MKTPL 123'))).not.toBeNull();
    expect(findPreRule([preRule('matches', '^CHASE\\d+')], tx('CHASE001'))).not.toBeNull();
    expect(findPreRule([preRule('matches', '^CHASE\\d+')], tx('NOT CHASE001'))).toBeNull();
  });
});

// ── matchesRule (and / or) ────────────────────────────────────────────────────

describe('conditionsOp', () => {
  const andRule: Rule = {
    stage: 'pre',
    conditionsOp: 'and',
    conditions: [
      { op: 'contains', field: 'imported_payee', value: 'AMAZON', type: 'string' },
      { op: 'contains', field: 'imported_payee', value: 'MKTPL', type: 'string' },
    ],
    actions: [{ op: 'set', field: 'payee', value: 'p-1', type: 'id' }],
  };

  const orRule: Rule = { ...andRule, conditionsOp: 'or' };

  it('and — requires all conditions', () => {
    expect(findPreRule([andRule], tx('AMAZON MKTPL 123'))).not.toBeNull(); // both match
    expect(findPreRule([andRule], tx('AMAZON FRESH'))).toBeNull();         // only first
    expect(findPreRule([andRule], tx('MKTPL ONLY'))).toBeNull();           // only second
  });

  it('or — requires at least one condition', () => {
    expect(findPreRule([orRule], tx('AMAZON FRESH'))).not.toBeNull();  // first only
    expect(findPreRule([orRule], tx('MKTPL ONLY'))).not.toBeNull();    // second only
    expect(findPreRule([orRule], tx('UNRELATED'))).toBeNull();         // neither
  });
});

// ── findPreRule ───────────────────────────────────────────────────────────────

describe('findPreRule', () => {
  it('returns null when no rules match', () => {
    expect(findPreRule([preRule('contains', 'AMAZON')], tx('STARBUCKS'))).toBeNull();
  });

  it('returns null when only null-stage rules exist', () => {
    expect(findPreRule([catRule('is', 'Amazon')], tx('Amazon'))).toBeNull();
  });

  it('returns first matching pre-stage rule', () => {
    const r1 = preRule('contains', 'AMAZON', 'p-1');
    const r2 = preRule('contains', 'AMAZON', 'p-2');
    const result = findPreRule([r1, r2], tx('AMAZON MKTPL'));
    expect((result!.actions[0] as any).value).toBe('p-1');
  });

  it('ignores null-stage rules when searching pre-stage', () => {
    const rules = [catRule('is', 'AMAZON'), preRule('contains', 'AMAZON')];
    expect(findPreRule(rules, tx('AMAZON'))).not.toBeNull();
    expect(findPreRule(rules, tx('AMAZON'))!.stage).toBe('pre');
  });
});

// ── findCategoryRule ──────────────────────────────────────────────────────────

describe('findCategoryRule', () => {
  it('matches clean payee name (case-insensitive)', () => {
    expect(findCategoryRule([catRule('is', 'amazon')], 'Amazon')).not.toBeNull();
    expect(findCategoryRule([catRule('is', 'Amazon')], 'amazon')).not.toBeNull();
  });

  it('returns null when no rules match', () => {
    expect(findCategoryRule([catRule('is', 'Amazon')], 'Starbucks')).toBeNull();
  });

  it('ignores pre-stage rules', () => {
    expect(findCategoryRule([preRule('contains', 'AMAZON')], 'AMAZON')).toBeNull();
  });

  it('returns first matching null-stage rule', () => {
    const r1 = catRule('is', 'Amazon', 'c-1');
    const r2 = catRule('is', 'Amazon', 'c-2');
    expect((findCategoryRule([r1, r2], 'Amazon')!.actions[0] as any).value).toBe('c-1');
  });
});
