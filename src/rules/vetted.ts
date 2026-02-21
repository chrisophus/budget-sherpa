import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { VettedStore, VettedRule, Rule } from '../types.js';

export class VettedRuleStore {
  private store: VettedStore;
  private path: string;
  private sessionKeys = new Set<string>();

  constructor(path: string) {
    this.path = path;
    this.store = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf-8'))
      : { version: 1, rules: {}, tags: {} };
    // Migrate old stores without tags field
    if (!this.store.tags) this.store.tags = {};
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

  getAllRules(): VettedRule[] {
    return Object.values(this.store.rules);
  }

  // Tag persistence — keyed by clean payee name
  hasTag(cleanPayee: string): boolean {
    return cleanPayee in this.store.tags;
  }

  getTag(cleanPayee: string): string | null {
    return this.store.tags[cleanPayee] ?? null;
  }

  setTag(cleanPayee: string, tag: string | null): void {
    this.store.tags[cleanPayee] = tag;
    this.save();
  }

  removeTag(cleanPayee: string): void {
    delete this.store.tags[cleanPayee];
    this.save();
  }

  remove(key: string): void {
    delete this.store.rules[key];
    this.sessionKeys.delete(key);
    this.save();
  }

  // Remove vetted rules that are now fully represented in Actual's rule set.
  // Called at startup after loading Actual rules so the store doesn't grow stale.
  // payeeById maps payee ID → name (needed to resolve string-type category conditions).
  cleanCoveredByActual(actualRules: Rule[], payeeById: Map<string, string>): void {
    const nameToId = new Map(
      [...payeeById.entries()].map(([id, name]) => [name.toLowerCase(), id]),
    );
    const preActualRules = actualRules.filter(r => r.stage === 'pre');
    const nullActualRules = actualRules.filter(r => r.stage === null);
    let changed = false;

    for (const vr of this.getAllRules().filter(r => r.stage === 'pre')) {
      const payeeId = nameToId.get(vr.actionValue.toLowerCase());
      if (!payeeId) continue;

      const isCoveredByActual = preActualRules.some(ar => {
        const c = ar.conditions[0];
        const a = ar.actions[0];
        return c && a &&
          c.op === vr.matchOp &&
          c.field === vr.matchField &&
          c.value.toLowerCase() === vr.matchValue.toLowerCase() &&
          a.field === 'payee' &&
          a.value === payeeId;
      });
      if (!isCoveredByActual) continue;

      delete this.store.rules[vr.key];
      this.sessionKeys.delete(vr.key);
      changed = true;

      // Clean the associated category rule if Actual also has it
      const catRule = this.getAllRules().find(
        r => r.stage === null && r.matchValue.toLowerCase() === vr.actionValue.toLowerCase(),
      );
      if (catRule) {
        const catCovered = nullActualRules.some(ar => {
          const c = ar.conditions[0];
          return c && c.field === 'payee' &&
            (c.value === payeeId || c.value.toLowerCase() === vr.actionValue.toLowerCase());
        });
        if (catCovered) {
          delete this.store.rules[catRule.key];
          this.sessionKeys.delete(catRule.key);
        }
      }

      // Clean the tag entry
      if (vr.actionValue in this.store.tags) {
        delete this.store.tags[vr.actionValue];
      }
    }

    if (changed) this.save();
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.store, null, 2), 'utf-8');
  }
}
