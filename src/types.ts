// --- QFX file metadata ---

export interface QfxFileMeta {
  filepath: string;
  acctId: string;
  acctType: 'credit' | 'checking' | 'savings';
  lastFour: string;
}

// --- Transactions ---

export interface RawTransaction {
  id: string;        // FITID - unique transaction ID from bank
  date: string;      // YYYYMMDD
  amount: number;    // positive = credit, negative = debit
  rawPayee: string;  // NAME field from QFX
  account: string;   // ACCTID
}

export interface ProcessedTransaction {
  raw: RawTransaction;
  cleanPayee: string | null;   // result of pre-stage rule
  category: string | null;     // result of null-stage rule
  preRuleKey: string | null;   // key of the matched pre-stage rule
  categoryRuleKey: string | null;
}

// --- Rules ---

export type RuleStage = 'pre' | null | 'post';
export type ConditionOp = 'contains' | 'is' | 'starts-with' | 'ends-with' | 'matches';
export type ConditionField = 'imported_payee' | 'payee' | 'notes' | 'amount';
export type ActionField = 'payee' | 'category' | 'notes';

export interface Condition {
  op: ConditionOp;
  field: ConditionField;
  value: string;
  type: 'string' | 'id';
}

export interface Action {
  op: 'set';
  field: ActionField;
  value: string;
  type: 'id';
}

export interface Rule {
  id?: string;
  stage: RuleStage;
  conditionsOp: 'and' | 'or';
  conditions: Condition[];
  actions: Action[];
}

// --- Vetted Rules Store ---

// Rules are keyed by a stable content hash so they survive ID changes
// Key format: "{stage}:{field}:{op}:{conditionValue}"
export interface VettedRule {
  key: string;
  stage: RuleStage;
  matchField: ConditionField;
  matchOp: ConditionOp;
  matchValue: string;
  actionField: ActionField;
  actionValue: string;    // clean payee name or category name
  vettedAt: string;       // ISO timestamp
}

export interface VettedStore {
  version: 1;
  rules: Record<string, VettedRule>;
  tags: Record<string, string | null>; // cleanPayee → tag name (null = explicitly none)
}

// --- LLM ---

export interface LLMAdapter {
  proposePayee(rawPayee: string, knownPayees: string[]): Promise<string>;
  proposeCategory(cleanPayee: string, categories: string[]): Promise<string>;
}

// --- Config ---

export interface Config {
  actualServerUrl: string;
  actualPassword: string;
  actualBudgetId: string;
  actualCaCert?: string;
  anthropicApiKey: string;
  vettedRulesPath: string;
}
