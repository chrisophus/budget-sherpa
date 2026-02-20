import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Suggestion, RawTransaction } from '../types.js';

// Mock inquirer before importing browse (which imports it at module load)
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input:  vi.fn(),
  confirm: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { withConcurrency, applySuggestions, saveDecisions, type PayeeRow } from './browse.js';
import { VettedRuleStore } from '../rules/vetted.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<PayeeRow> = {}): PayeeRow {
  return {
    rawPayees:   ['RAW PAYEE 1'],
    txCount:     3,
    matchValue:  'RAW PAYEE',
    cleanPayee:  'Clean Payee',
    category:    null,
    tag:         null,
    tagDecided:  false,
    preRuleKey:  'pre:imported_payee:contains:RAW PAYEE:payee:Clean Payee',
    wasVetted:   false,
    touched:     false,
    skipped:     false,
    ...overrides,
  };
}

function makeTx(rawPayee = 'RAW PAYEE 1', count = 3): RawTransaction[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `TX${i}`, date: '20260101', amount: -10, rawPayee, account: 'A1',
  }));
}

// ── withConcurrency ───────────────────────────────────────────────────────────

describe('withConcurrency', () => {
  it('processes all items', async () => {
    const results: number[] = [];
    await withConcurrency([1, 2, 3, 4, 5], 2, async n => { results.push(n); });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles empty list', async () => {
    await expect(withConcurrency([], 5, async () => {})).resolves.toBeUndefined();
  });

  it('works when concurrency > item count', async () => {
    const results: number[] = [];
    await withConcurrency([1, 2], 10, async n => { results.push(n); });
    expect(results.sort()).toEqual([1, 2]);
  });

  it('limits in-flight count', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await withConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

// ── applySuggestions ──────────────────────────────────────────────────────────

describe('applySuggestions', () => {
  beforeEach(() => {
    vi.mocked(select).mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('rename — updates cleanPayee and preRuleKey on all matching rows', async () => {
    const rows = [
      makeRow({ cleanPayee: 'Gas Station', matchValue: 'SINCLAIR' }),
      makeRow({ cleanPayee: 'Gas Station', matchValue: 'CONOCO' }),
    ];
    const suggestion: Suggestion = {
      type: 'rename', cleanPayee: 'Gas Station', suggestedName: 'Sinclair', reason: 'Too generic',
    };

    vi.mocked(select).mockResolvedValue('accept');
    await applySuggestions([suggestion], rows, new Map());

    expect(rows[0].cleanPayee).toBe('Sinclair');
    expect(rows[1].cleanPayee).toBe('Sinclair');
    expect(rows[0].touched).toBe(true);
    expect(rows[1].touched).toBe(true);
    expect(rows[0].preRuleKey).toContain('Sinclair');
  });

  it('rename — skipped when user says skip', async () => {
    const rows = [makeRow({ cleanPayee: 'Gas Station' })];
    vi.mocked(select).mockResolvedValue('skip');
    await applySuggestions([{ type: 'rename', cleanPayee: 'Gas Station', suggestedName: 'Sinclair', reason: '' }], rows, new Map());
    expect(rows[0].cleanPayee).toBe('Gas Station');
    expect(rows[0].touched).toBe(false);
  });

  it('category — updates category on all matching rows', async () => {
    const rows = [
      makeRow({ cleanPayee: 'Amazon', category: null }),
      makeRow({ cleanPayee: 'Amazon', matchValue: 'AMAZON FRESH', category: null }),
    ];
    vi.mocked(select).mockResolvedValue('accept');
    await applySuggestions(
      [{ type: 'category', cleanPayee: 'Amazon', suggestedCategory: 'Shopping', reason: '' }],
      rows, new Map(),
    );
    expect(rows[0].category).toBe('Shopping');
    expect(rows[1].category).toBe('Shopping');
  });

  it('split — moves raw payees from existing row to new row', async () => {
    const byRawPayee = new Map([
      ['SINCLAIR GAS #12', makeTx('SINCLAIR GAS #12', 2)],
      ['CONOCO #45',       makeTx('CONOCO #45', 5)],
    ]);
    const rows = [
      makeRow({
        cleanPayee: 'Gas Station',
        rawPayees: ['SINCLAIR GAS #12', 'CONOCO #45'],
        txCount: 7,
      }),
    ];

    vi.mocked(select).mockResolvedValue('accept');
    await applySuggestions([{
      type: 'split',
      cleanPayee: 'Gas Station',
      rawPayees: ['CONOCO #45'],
      suggestedName: 'Conoco',
      reason: 'Different brand',
    }], rows, byRawPayee);

    // Original row has CONOCO removed
    expect(rows[0].rawPayees).toEqual(['SINCLAIR GAS #12']);
    expect(rows[0].txCount).toBe(2);

    // New row was appended
    const newRow = rows[1];
    expect(newRow.cleanPayee).toBe('Conoco');
    expect(newRow.rawPayees).toEqual(['CONOCO #45']);
    expect(newRow.txCount).toBe(5);
    expect(newRow.wasVetted).toBe(false);
    expect(newRow.touched).toBe(true);
  });

  it('split — warns and skips when raw payees not found', async () => {
    const rows = [makeRow({ cleanPayee: 'Gas Station', rawPayees: ['SINCLAIR'] })];
    vi.mocked(select).mockResolvedValue('accept');
    const initialLength = rows.length;

    await applySuggestions([{
      type: 'split',
      cleanPayee: 'Gas Station',
      rawPayees: ['NONEXISTENT'],
      suggestedName: 'Other',
      reason: '',
    }], rows, new Map());

    expect(rows).toHaveLength(initialLength); // no new row added
    expect(rows[0].rawPayees).toEqual(['SINCLAIR']); // unchanged
  });

  it('flag — no automatic change, just displayed', async () => {
    const rows = [makeRow({ cleanPayee: 'Auto Payment' })];
    vi.mocked(select).mockResolvedValue('accept');
    await applySuggestions([{ type: 'flag', cleanPayee: 'Auto Payment', reason: 'Possible transfer' }], rows, new Map());
    // flag type makes no mutation
    expect(rows[0].touched).toBe(false);
  });

  it('skips suggestions where cleanPayee does not match any row', async () => {
    const rows = [makeRow({ cleanPayee: 'Amazon' })];
    vi.mocked(select).mockResolvedValue('accept');
    await applySuggestions([{ type: 'rename', cleanPayee: 'Nonexistent', suggestedName: 'X', reason: '' }], rows, new Map());
    // select should never have been called since no matching rows
    expect(vi.mocked(select)).not.toHaveBeenCalled();
  });
});

// ── saveDecisions (Phase 4 stale-rule cleanup) ────────────────────────────────

function tmpStore() {
  const path = join(tmpdir(), `vetted-browse-${Date.now()}.json`);
  const store = new VettedRuleStore(path);
  const cleanup = () => { if (existsSync(path)) unlinkSync(path); };
  return { store, cleanup };
}

describe('saveDecisions', () => {
  it('builds payeeMap from non-skipped rows', () => {
    const { store, cleanup } = tmpStore();
    try {
      const rows = [
        makeRow({ rawPayees: ['RAW A'], cleanPayee: 'Amazon' }),
        makeRow({ rawPayees: ['RAW B'], cleanPayee: 'Starbucks', skipped: true }),
      ];
      const map = saveDecisions(rows, store, []);
      expect(map.get('RAW A')).toBe('Amazon');
      expect(map.has('RAW B')).toBe(false);
    } finally { cleanup(); }
  });

  it('rename — removes old pre-rule and saves new one', () => {
    const { store, cleanup } = tmpStore();
    try {
      // Seed an old rule: SINCLAIR GAS → Gas Station
      const oldKey = 'pre:imported_payee:contains:SINCLAIR GAS:payee:Gas Station';
      store.approve({ key: oldKey, stage: 'pre', matchField: 'imported_payee', matchOp: 'contains',
        matchValue: 'SINCLAIR GAS', actionField: 'payee', actionValue: 'Gas Station', vettedAt: '' });

      const newKey = 'pre:imported_payee:contains:SINCLAIR GAS:payee:Sinclair';
      const row = makeRow({
        matchValue: 'SINCLAIR GAS', cleanPayee: 'Sinclair',
        preRuleKey: newKey, wasVetted: true, touched: true,
      });
      saveDecisions([row], store, []);

      expect(store.isVetted(oldKey)).toBe(false); // old rule removed
      expect(store.isVetted(newKey)).toBe(true);  // new rule saved
      expect(store.findPayeeRule('SINCLAIR GAS #12')?.actionValue).toBe('Sinclair');
    } finally { cleanup(); }
  });

  it('split — removes rule for emptied row so payees don\'t re-join old group', () => {
    const { store, cleanup } = tmpStore();
    try {
      // Seed old rule: CONOCO MART → Gas Station
      const oldKey = 'pre:imported_payee:contains:CONOCO MART:payee:Gas Station';
      store.approve({ key: oldKey, stage: 'pre', matchField: 'imported_payee', matchOp: 'contains',
        matchValue: 'CONOCO MART', actionField: 'payee', actionValue: 'Gas Station', vettedAt: '' });

      // After split: original row is empty, new row has the payees
      const emptyRow = makeRow({ matchValue: 'CONOCO MART', rawPayees: [], wasVetted: true, touched: true });
      const newRow  = makeRow({ matchValue: 'CONOCO MART', rawPayees: ['CONOCO MART #12'],
        cleanPayee: 'Conoco', preRuleKey: 'pre:imported_payee:contains:CONOCO MART:payee:Conoco', touched: true });

      saveDecisions([emptyRow, newRow], store, []);

      expect(store.isVetted(oldKey)).toBe(false); // old rule removed by empty-row cleanup
      expect(store.findPayeeRule('CONOCO MART #12')?.actionValue).toBe('Conoco');
    } finally { cleanup(); }
  });

  it('previously vetted untouched row is not re-saved but still added to payeeMap', () => {
    const { store, cleanup } = tmpStore();
    try {
      const key = 'pre:imported_payee:contains:AMAZON:payee:Amazon';
      store.approve({ key, stage: 'pre', matchField: 'imported_payee', matchOp: 'contains',
        matchValue: 'AMAZON', actionField: 'payee', actionValue: 'Amazon', vettedAt: '' });
      const sessionKeysBefore = store.getSessionRules().length;

      const row = makeRow({ matchValue: 'AMAZON', rawPayees: ['AMAZON MKTPL'], cleanPayee: 'Amazon',
        preRuleKey: key, wasVetted: true, touched: false });
      const map = saveDecisions([row], store, []);

      expect(map.get('AMAZON MKTPL')).toBe('Amazon');
      // approve() was NOT called again, so session rules count unchanged
      expect(store.getSessionRules().length).toBe(sessionKeysBefore);
    } finally { cleanup(); }
  });
});
