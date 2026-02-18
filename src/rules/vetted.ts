import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { VettedStore, VettedRule } from '../types.js';

export class VettedRuleStore {
  private store: VettedStore;
  private path: string;
  private sessionKeys = new Set<string>();

  constructor(path: string) {
    this.path = path;
    this.store = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf-8'))
      : { version: 1, rules: {} };
  }

  isVetted(key: string): boolean {
    return key in this.store.rules;
  }

  get(key: string): VettedRule | undefined {
    return this.store.rules[key];
  }

  findPayeeRule(rawPayee: string): VettedRule | undefined {
    return Object.values(this.store.rules).find(r =>
      r.stage === 'pre' &&
      r.matchField === 'imported_payee' &&
      rawPayee.toLowerCase().includes(r.matchValue.toLowerCase())
    );
  }

  findCategoryRule(cleanPayee: string): VettedRule | undefined {
    return Object.values(this.store.rules).find(r =>
      r.stage === null &&
      r.matchField === 'payee' &&
      r.matchValue.toLowerCase() === cleanPayee.toLowerCase()
    );
  }

  approve(rule: VettedRule): void {
    this.store.rules[rule.key] = { ...rule, vettedAt: new Date().toISOString() };
    this.sessionKeys.add(rule.key);
    this.save();
  }

  getSessionRules(): VettedRule[] {
    return [...this.sessionKeys].map(k => this.store.rules[k]).filter(Boolean);
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.store, null, 2), 'utf-8');
  }
}
