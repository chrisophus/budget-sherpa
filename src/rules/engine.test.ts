import { describe, it, expect } from 'vitest';
import { ruleKey, findPreRule, findCategoryRule, classifyByRuleCoverage, flatCategoryNames } from './engine.js';
import type { Rule, RawTransaction, CategoryGroup } from '../types.js';

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

  it('ignores post-stage rules even if payee matches', () => {
    const postRule: Rule = {
      stage: 'post',
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: 'Amazon', type: 'id' }],
      actions: [{ op: 'set', field: 'category', value: 'c-post', type: 'id' }],
    };
    // findCategoryRule filters to stage === null only, so post-stage is ignored
    expect(findCategoryRule([postRule], 'Amazon')).toBeNull();
  });
});

// ── ruleKey with multi-condition rule ─────────────────────────────────────────

describe('ruleKey — multi-condition rule', () => {
  it('only uses conditions[0] in the key (documented behavior)', () => {
    // A rule with two conditions — ruleKey only reflects the first
    const rule: Rule = {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [
        { op: 'contains', field: 'imported_payee', value: 'AMAZON', type: 'string' },
        { op: 'contains', field: 'imported_payee', value: 'MKTPL', type: 'string' },
      ],
      actions: [{ op: 'set', field: 'payee', value: 'p-1', type: 'id' }],
    };
    // The key only encodes the first condition value
    expect(ruleKey(rule)).toBe('pre:imported_payee:contains:AMAZON:payee:p-1');
    // It does NOT include 'MKTPL' — two different multi-condition rules with the
    // same first condition would collide. This is a known limitation.
    expect(ruleKey(rule)).not.toContain('MKTPL');
  });
});

// ── classifyByRuleCoverage ────────────────────────────────────────────────────

describe('classifyByRuleCoverage', () => {
  const payeeById = new Map([['p-amazon', 'Amazon'], ['p-sbux', 'Starbucks']]);

  const amazonPreRule = preRule('contains', 'AMAZON', 'p-amazon');
  const amazonCatRule: Rule = {
    stage: null,
    conditionsOp: 'and',
    conditions: [{ op: 'is', field: 'payee', value: 'p-amazon', type: 'id' }],
    actions: [{ op: 'set', field: 'category', value: 'c-shopping', type: 'id' }],
  };
  const sbuxPreRule = preRule('contains', 'STARBUCKS', 'p-sbux');

  it('covered: pre-rule and category rule both exist', () => {
    const rules = [amazonPreRule, amazonCatRule];
    const result = classifyByRuleCoverage(rules, ['AMAZON MKTPL 123'], payeeById);
    expect(result.covered).toEqual(['AMAZON MKTPL 123']);
    expect(result.needsCategory).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('needsCategory: pre-rule exists but no category rule', () => {
    const result = classifyByRuleCoverage([sbuxPreRule], ['STARBUCKS #4567'], payeeById);
    expect(result.needsCategory).toEqual(['STARBUCKS #4567']);
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  it('uncovered: no pre-rule matches', () => {
    const result = classifyByRuleCoverage([amazonPreRule, amazonCatRule], ['TARGET 001'], payeeById);
    expect(result.uncovered).toEqual(['TARGET 001']);
    expect(result.covered).toEqual([]);
    expect(result.needsCategory).toEqual([]);
  });

  it('classifies multiple payees into correct buckets', () => {
    const rules = [amazonPreRule, amazonCatRule, sbuxPreRule];
    const result = classifyByRuleCoverage(
      rules,
      ['AMAZON MKTPL 123', 'STARBUCKS #4567', 'UNKNOWN VENDOR'],
      payeeById,
    );
    expect(result.covered).toEqual(['AMAZON MKTPL 123']);
    expect(result.needsCategory).toEqual(['STARBUCKS #4567']);
    expect(result.uncovered).toEqual(['UNKNOWN VENDOR']);
  });

  it('handles string-type category rule conditions (manually created in Actual UI)', () => {
    const nameCatRule: Rule = {
      stage: null,
      conditionsOp: 'and',
      conditions: [{ op: 'is', field: 'payee', value: 'Amazon', type: 'string' }],
      actions: [{ op: 'set', field: 'category', value: 'c-shopping', type: 'id' }],
    };
    const result = classifyByRuleCoverage([amazonPreRule, nameCatRule], ['AMAZON MKTPL 123'], payeeById);
    expect(result.covered).toEqual(['AMAZON MKTPL 123']);
  });

  it('returns uncovered when pre-rule has no payee action', () => {
    const badPreRule: Rule = {
      stage: 'pre',
      conditionsOp: 'and',
      conditions: [{ op: 'contains', field: 'imported_payee', value: 'AMAZON', type: 'string' }],
      actions: [{ op: 'set', field: 'notes', value: 'something', type: 'string' }],
    };
    const result = classifyByRuleCoverage([badPreRule], ['AMAZON MKTPL 123'], payeeById);
    expect(result.uncovered).toEqual(['AMAZON MKTPL 123']);
  });
});

// ── flatCategoryNames ─────────────────────────────────────────────────────────

describe('flatCategoryNames', () => {
  const groups: CategoryGroup[] = [
    {
      id: 'g1', name: 'Food', hidden: false, is_income: false,
      categories: [
        { id: 'c1', name: 'Groceries', group_id: 'g1', hidden: false },
        { id: 'c2', name: 'Dining Out', group_id: 'g1', hidden: false },
      ],
    },
    {
      id: 'g2', name: 'Housing', hidden: false, is_income: false,
      categories: [
        { id: 'c3', name: 'Rent', group_id: 'g2', hidden: false },
      ],
    },
  ];

  it('flattens all categories across groups', () => {
    expect(flatCategoryNames(groups)).toEqual(['Groceries', 'Dining Out', 'Rent']);
  });

  it('returns empty array for empty groups', () => {
    expect(flatCategoryNames([])).toEqual([]);
  });
});
