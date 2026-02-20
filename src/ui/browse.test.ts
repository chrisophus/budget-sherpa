import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Suggestion, RawTransaction } from '../types.js';

// Mock inquirer before importing browse (which imports it at module load)
vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input:  vi.fn(),
  confirm: vi.fn(),
}));

import { select } from '@inquirer/prompts';
import { withConcurrency, applySuggestions, type PayeeRow } from './browse.js';

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
