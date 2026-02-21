// --- Actual Budget category groups ---

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  is_income: boolean;
  categories: Array<{ id: string; name: string; group_id: string; hidden: boolean }>;
}

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
  amount: number;    // dollars (float), positive = credit, negative = debit; convert to cents (* 100) for Actual
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
  op: 'set' | 'append-notes' | 'prepend-notes';
  field: ActionField;
  value: string;
  type: 'id' | 'string';
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

export interface GroupForReview {
  cleanPayee: string;
  category: string | null;
  rawPayees: string[];
}

export type SuggestionType = 'split' | 'rename' | 'category' | 'flag';

export interface Suggestion {
  type: SuggestionType;
  cleanPayee: string;          // current clean name this applies to
  rawPayees?: string[];        // split: the specific raw payees to split off
  suggestedName?: string;      // split/rename: new name
  suggestedCategory?: string;  // split/category: new category
  reason: string;
}

export interface ConsolidationGroup {
  actionValue: string;   // clean payee name shared by all rules
  matchValues: string[]; // current match patterns (2+)
}

export interface ConsolidationSuggestion {
  actionValue: string;         // identifies which group this applies to
  suggestedMatchValue: string; // the proposed consolidated match pattern
  reason: string;
}

export interface LLMAdapter {
  proposePayee(rawPayee: string, knownPayees: string[]): Promise<string>;
  proposeCategory(cleanPayee: string, categories: string[]): Promise<string>;
  reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]>;
  suggestConsolidation(groups: ConsolidationGroup[]): Promise<ConsolidationSuggestion[]>;
}

// --- Config ---

export interface Config {
  actualServerUrl: string;
  actualPassword: string;
  actualBudgetId: string;
  actualCaCert?: string;
  llmProvider: 'anthropic' | 'openai';
  anthropicApiKey?: string;
  openaiApiKey?: string;
  vettedRulesPath: string;
  dryRun: boolean;
  // Model overrides (optional — defaults are hardcoded in each adapter)
  anthropicFastModel?: string;
  anthropicReviewModel?: string;
  openaiModel?: string;
  openaiReviewModel?: string;
}
