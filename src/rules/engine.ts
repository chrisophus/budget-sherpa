import type { Rule, RawTransaction, Condition } from '../types.js';

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
