import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { VettedRuleStore } from '../rules/vetted.js';
import type { VettedRule } from '../types.js';
import { buildConsolidationGroups } from './session.js';

function tmpPath() {
  return join(tmpdir(), `core-session-test-${Date.now()}.json`);
}

function makePreRule(matchValue: string, actionValue: string): VettedRule {
  return {
    key: `pre:imported_payee:contains:${matchValue}:payee:${actionValue}`,
    stage: 'pre',
    matchField: 'imported_payee',
    matchOp: 'contains',
    matchValue,
    actionField: 'payee',
    actionValue,
    vettedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildConsolidationGroups', () => {
  let path: string;
  let vetted: VettedRuleStore;

  beforeEach(() => {
    path = tmpPath();
    vetted = new VettedRuleStore(path);
  });

  afterEach(() => {
    if (existsSync(path)) unlinkSync(path);
  });

  it('returns empty array when all payees have only one match pattern', () => {
    vetted.approve(makePreRule('AMAZON MKTPL', 'Amazon'));
    vetted.approve(makePreRule('COSTCO', 'Costco'));

    const groups = buildConsolidationGroups(vetted);

    expect(groups).toHaveLength(0);
  });

  it('groups rules with the same actionValue into one ConsolidationGroup', () => {
    vetted.approve(makePreRule('CAPITAL ONE CRCARDPMT 43FA', 'Capital One'));
    vetted.approve(makePreRule('CAPITAL ONE CRCARDPMT 43S6', 'Capital One'));
    vetted.approve(makePreRule('CAPITAL ONE AUTOPAY XYZ', 'Capital One'));

    const groups = buildConsolidationGroups(vetted);

    expect(groups).toHaveLength(1);
    expect(groups[0].actionValue).toBe('Capital One');
    expect(groups[0].matchValues).toHaveLength(3);
    expect(groups[0].matchValues).toContain('CAPITAL ONE CRCARDPMT 43FA');
    expect(groups[0].matchValues).toContain('CAPITAL ONE CRCARDPMT 43S6');
    expect(groups[0].matchValues).toContain('CAPITAL ONE AUTOPAY XYZ');
  });

  it('groups rules case-insensitively by actionValue', () => {
    // Two rules with the same payee but different casing (shouldn't happen normally, but guard against it)
    vetted.approve(makePreRule('CHASE PAY 001', 'Chase'));
    vetted.approve(makePreRule('CHASE AUTOPAY 002', 'chase'));

    const groups = buildConsolidationGroups(vetted);

    expect(groups).toHaveLength(1);
    expect(groups[0].matchValues).toHaveLength(2);
  });
});
