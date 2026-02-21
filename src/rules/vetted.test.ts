import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VettedRuleStore } from './vetted.js';
import type { VettedRule } from '../types.js';

function tmpPath() {
  return join(tmpdir(), `vetted-test-${Date.now()}.json`);
}

function makeRule(overrides: Partial<VettedRule> = {}): VettedRule {
  return {
    key: 'pre:imported_payee:contains:AMAZON:payee:Amazon',
    stage: 'pre',
    matchField: 'imported_payee',
    matchOp: 'contains',
    matchValue: 'AMAZON',
    actionField: 'payee',
    actionValue: 'Amazon',
    vettedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('VettedRuleStore', () => {
  let path: string;
  let store: VettedRuleStore;

  beforeEach(() => {
    path = tmpPath();
    store = new VettedRuleStore(path);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('starts empty', () => {
    expect(store.getAllRules()).toHaveLength(0);
    expect(store.getSessionRules()).toHaveLength(0);
  });

  it('approve() persists a rule and marks it as session rule', () => {
    const rule = makeRule();
    store.approve(rule);
    expect(store.isVetted(rule.key)).toBe(true);
    expect(store.getAllRules()).toHaveLength(1);
    expect(store.getSessionRules()).toHaveLength(1);
  });

  it('getAllRules() returns previously saved rules on reload', () => {
    store.approve(makeRule());
    const reloaded = new VettedRuleStore(path);
    expect(reloaded.getAllRules()).toHaveLength(1);
    // Not a session rule in the new instance
    expect(reloaded.getSessionRules()).toHaveLength(0);
  });

  it('remove() deletes from store and session', () => {
    const rule = makeRule();
    store.approve(rule);
    store.remove(rule.key);
    expect(store.isVetted(rule.key)).toBe(false);
    expect(store.getAllRules()).toHaveLength(0);
    expect(store.getSessionRules()).toHaveLength(0);
  });

  it('findPayeeRule() matches by substring', () => {
    store.approve(makeRule({ matchValue: 'AMAZON' }));
    expect(store.findPayeeRule('AMAZON MKTPL 12345')?.actionValue).toBe('Amazon');
    expect(store.findPayeeRule('STARBUCKS')).toBeUndefined();
  });

  it('findCategoryRule() matches by clean payee name (case-insensitive)', () => {
    store.approve(makeRule({
      key: 'null:payee:is:Amazon:category:Shopping',
      stage: null,
      matchField: 'payee',
      matchOp: 'is',
      matchValue: 'Amazon',
      actionField: 'category',
      actionValue: 'Shopping',
    }));
    expect(store.findCategoryRule('Amazon')?.actionValue).toBe('Shopping');
    expect(store.findCategoryRule('amazon')?.actionValue).toBe('Shopping');
    expect(store.findCategoryRule('Walmart')).toBeUndefined();
  });

  it('tag operations work correctly', () => {
    store.setTag('Amazon', 'discretionary');
    expect(store.hasTag('Amazon')).toBe(true);
    expect(store.getTag('Amazon')).toBe('discretionary');

    store.setTag('Amazon', null);
    expect(store.getTag('Amazon')).toBeNull();

    store.removeTag('Amazon');
    expect(store.hasTag('Amazon')).toBe(false);
  });

  it('migrates old format without tags field — hasTag returns false, getTag returns null', () => {
    // Write a store with rules but no tags key (old format)
    const oldFormat = JSON.stringify({ version: 1, rules: {} });
    writeFileSync(path, oldFormat, 'utf-8');
    const migrated = new VettedRuleStore(path);
    expect(migrated.hasTag('Amazon')).toBe(false);
    expect(migrated.getTag('Amazon')).toBeNull();
  });

  it('getSessionRules() is empty after approve() then remove() for same key', () => {
    const rule = makeRule();
    store.approve(rule);
    expect(store.getSessionRules()).toHaveLength(1);
    store.remove(rule.key);
    expect(store.getSessionRules()).toHaveLength(0);
  });
});
