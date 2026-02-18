import * as api from '@actual-app/api';
import { mkdirSync, rmSync, readdirSync } from 'fs';
import type { Rule } from '../types.js';

// Suppress verbose background-sync noise from @actual-app/api.
// The library logs these to stdout on every sync cycle; they're not useful to end users.
const SUPPRESSED = [
  /^Syncing since /,
  /^Got messages from server /,
  /^Making backup/,
  /^Loaded budget /,
];
const _log = console.log.bind(console);
console.log = (...args: any[]) => {
  if (args.length > 0 && typeof args[0] === 'string' && SUPPRESSED.some(r => r.test(args[0]))) return;
  _log(...args);
};

export class ActualClient {
  private initialized = false;

  async init(serverUrl: string, password: string, budgetId: string, dataDir = './data'): Promise<void> {
    mkdirSync(dataDir, { recursive: true });
    await api.init({ serverURL: serverUrl, password, dataDir });
    try {
      await api.downloadBudget(budgetId);
    } catch (err: any) {
      // If download fails and there's a local cache, it may be stale (e.g. budget was
      // reset on the server). Clear it and retry once — the cache is just a mirror so
      // clearing it is always safe. Re-throw if the retry also fails.
      const hasCache = readdirSync(dataDir).length > 0;
      if (!hasCache) throw err;
      console.error('Budget download failed with local cache present — clearing cache and retrying...');
      await api.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
      mkdirSync(dataDir, { recursive: true });
      await api.init({ serverURL: serverUrl, password, dataDir });
      await api.downloadBudget(budgetId);
    }
    this.initialized = true;
  }

  async getRules(): Promise<Rule[]> {
    return (await api.getRules()) as unknown as Rule[];
  }

  async getPayees(): Promise<Array<{ id: string; name: string }>> {
    return api.getPayees();
  }

  async getCategories(): Promise<Array<{ id: string; name: string; group_id: string }>> {
    return api.getCategories() as any;
  }

  async createRule(rule: Omit<Rule, 'id'>): Promise<string> {
    return api.createRule(rule as any) as any;
  }

  async getBudgets(): Promise<Array<{ groupId: string; name: string }>> {
    return api.getBudgets() as any;
  }

  async getAccounts(): Promise<Array<{ id: string; name: string }>> {
    return api.getAccounts() as any;
  }

  async createPayee(name: string): Promise<string> {
    return api.createPayee({ name }) as any;
  }

  async createAccount(account: { name: string; type: string }, initialBalance = 0): Promise<string> {
    return api.createAccount(account as any, initialBalance) as any;
  }

  async importTransactions(accountId: string, transactions: any[]): Promise<{ added: string[]; updated: string[]; errors: any[] }> {
    return api.importTransactions(accountId, transactions) as any;
  }

  async getTransactions(accountId: string, startDate = '2000-01-01', endDate = '2099-12-31'): Promise<any[]> {
    return api.getTransactions(accountId, startDate, endDate) as any;
  }

  async updateTransaction(id: string, fields: any): Promise<void> {
    return api.updateTransaction(id, fields) as any;
  }

  async sync(): Promise<void> {
    if (this.initialized) await api.sync();
  }

  async shutdown(): Promise<void> {
    if (this.initialized) {
      await api.sync();
      await api.shutdown();
    }
  }
}
