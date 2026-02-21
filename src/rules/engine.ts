import type { Rule, RawTransaction, Condition, CategoryGroup } from '../types.js';

// Stable key for a rule based on its content (not its ID)
export function ruleKey(rule: Rule): string {
  const c = rule.conditions[0];
  const a = rule.actions[0];
  return `${rule.stage ?? 'null'}:${c.field}:${c.op}:${c.value}:${a.field}:${a.value}`;
}

function matchesCondition(condition: Condition, rawPayee: string, cleanPayee?: string): boolean {
  const subject = condition.field === 'imported_payee' ? rawPayee : (cleanPayee ?? '');
  const value = condition.value.toLowerCase();
  const s = subject.toLowerCase();

  switch (condition.op) {
    case 'contains':     return s.includes(value);
    case 'is':           return s === value;
    case 'starts-with':  return s.startsWith(value);
    case 'ends-with':    return s.endsWith(value);
    case 'matches':      return new RegExp(condition.value, 'i').test(subject);
  }
}

function matchesRule(rule: Rule, rawPayee: string, cleanPayee?: string): boolean {
  const fn = (c: Condition) => matchesCondition(c, rawPayee, cleanPayee);
  return rule.conditionsOp === 'and'
    ? rule.conditions.every(fn)
    : rule.conditions.some(fn);
}

// Find the first pre-stage rule that matches the raw payee
export function findPreRule(rules: Rule[], tx: RawTransaction): Rule | null {
  return rules
    .filter(r => r.stage === 'pre')
    .find(r => matchesRule(r, tx.rawPayee)) ?? null;
}

// Find the first null-stage rule that matches the clean payee
export function findCategoryRule(rules: Rule[], cleanPayee: string): Rule | null {
  return rules
    .filter(r => r.stage === null)
    .find(r => matchesRule(r, '', cleanPayee)) ?? null;
}

// --- Coverage analysis ---

export interface CoverageResult {
  covered: string[];       // have a pre-rule AND a category rule in Actual
  needsCategory: string[]; // have a pre-rule but no category rule
  uncovered: string[];     // no pre-rule at all
}

// Classify unique raw payees by how well they are covered by existing Actual rules.
// payeeById maps payee ID → payee name (used to resolve category rule conditions).
export function classifyByRuleCoverage(
  rules: Rule[],
  uniqueRawPayees: string[],
  payeeById: Map<string, string>,
): CoverageResult {
  const covered: string[] = [];
  const needsCategory: string[] = [];
  const uncovered: string[] = [];

  const preRules = rules.filter(r => r.stage === 'pre');
  const nullRules = rules.filter(r => r.stage === null);

  for (const rawPayee of uniqueRawPayees) {
    const preRule = preRules.find(r => matchesRule(r, rawPayee));
    if (!preRule) {
      uncovered.push(rawPayee);
      continue;
    }

    const payeeId = preRule.actions.find(a => a.field === 'payee')?.value;
    if (!payeeId) {
      uncovered.push(rawPayee);
      continue;
    }

    const payeeName = payeeById.get(payeeId);
    const hasCategoryRule = nullRules.some(r => {
      const c = r.conditions[0];
      if (!c || c.field !== 'payee') return false;
      // ID-based condition (common — budget-sherpa always creates these)
      if (c.type === 'id') return c.value === payeeId;
      // String/name-based condition (manually created rules in Actual UI)
      return payeeName ? matchesRule(r, '', payeeName) : false;
    });

    if (hasCategoryRule) {
      covered.push(rawPayee);
    } else {
      needsCategory.push(rawPayee);
    }
  }

  return { covered, needsCategory, uncovered };
}

// Flatten a CategoryGroup[] into a plain string[] for LLM prompts.
export function flatCategoryNames(groups: CategoryGroup[]): string[] {
  return groups.flatMap(g => g.categories.map(c => c.name));
}
