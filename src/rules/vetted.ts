import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { VettedStore, VettedRule } from '../types.js';

export class VettedRuleStore {
  private store: VettedStore;
  private path: string;

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

  approve(rule: VettedRule): void {
    this.store.rules[rule.key] = { ...rule, vettedAt: new Date().toISOString() };
    this.save();
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.store, null, 2), 'utf-8');
  }
}
