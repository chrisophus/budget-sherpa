import type { ConsolidationGroup } from '../types.js';
import type { VettedRuleStore } from '../rules/vetted.js';

// Group pre-stage vetted rules by actionValue (clean payee name), case-insensitive.
// Returns only groups with 2+ distinct match patterns — these are consolidation candidates.
export function buildConsolidationGroups(vetted: VettedRuleStore): ConsolidationGroup[] {
  const allPreRules = vetted.getAllRules().filter(r => r.stage === 'pre');
  const byAction = new Map<string, { actionValue: string; matchValues: string[] }>();

  for (const rule of allPreRules) {
    const key = rule.actionValue.toLowerCase();
    if (!byAction.has(key)) {
      byAction.set(key, { actionValue: rule.actionValue, matchValues: [] });
    }
    byAction.get(key)!.matchValues.push(rule.matchValue);
  }

  return [...byAction.values()]
    .filter(g => g.matchValues.length > 1)
    .map(g => ({ actionValue: g.actionValue, matchValues: g.matchValues }));
}
