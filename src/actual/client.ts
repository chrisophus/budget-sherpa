import * as api from '@actual-app/api';
import { mkdirSync } from 'fs';
import type { Rule } from '../types.js';

export class ActualClient {
  private initialized = false;

  async init(serverUrl: string, password: string, budgetId: string, dataDir = './data'): Promise<void> {
    mkdirSync(dataDir, { recursive: true });
    await api.init({ serverURL: serverUrl, password, dataDir });
    await api.downloadBudget(budgetId);
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

  async shutdown(): Promise<void> {
    if (this.initialized) await api.shutdown();
  }
}
