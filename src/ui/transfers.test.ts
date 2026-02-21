import { describe, it, expect } from 'vitest';
import { findTransferPairs, daysBetween, formatAmount, DATE_TOLERANCE_DAYS } from './transfers.js';

interface Tx {
  id: string;
  date: string;
  amount: number;
  imported_payee?: string;
  transfer_id?: string | null;
}

function tx(id: string, date: string, amount: number): Tx {
  return { id, date, amount };
}

describe('formatAmount', () => {
  it('converts cents to dollar display string', () => {
    expect(formatAmount(19900)).toBe('$199.00');
    expect(formatAmount(500)).toBe('$5.00');
  });

  it('handles negative amounts (shows absolute value)', () => {
    expect(formatAmount(-19900)).toBe('$199.00');
  });
});

describe('daysBetween', () => {
  it('returns 0 for same date', () => {
    expect(daysBetween('2026-01-15', '2026-01-15')).toBe(0);
  });

  it('returns correct day count', () => {
    expect(daysBetween('2026-01-15', '2026-01-18')).toBe(3);
    expect(daysBetween('2026-01-18', '2026-01-15')).toBe(3); // order-independent
  });
});

describe('findTransferPairs', () => {
  const accountNames = new Map([['checking', 'Checking'], ['credit', 'Credit Card']]);

  it('matches a simple transfer pair', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-20', -19900)]],
      ['credit',   [tx('CC1', '2026-01-20', 19900)]],
    ]);
    const pairs = findTransferPairs(txsByAccount, accountNames);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].outTx.id).toBe('C1');
    expect(pairs[0].inTx.id).toBe('CC1');
    expect(pairs[0].outAcctId).toBe('checking');
    expect(pairs[0].inAcctId).toBe('credit');
  });

  it('matches within date tolerance', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-20', -19900)]],
      ['credit',   [tx('CC1', `2026-01-${20 + DATE_TOLERANCE_DAYS}`, 19900)]],
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(1);
  });

  it('rejects pairs outside date tolerance', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-01', -19900)]],
      ['credit',   [tx('CC1', '2026-01-10', 19900)]],  // 9 days apart
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(0);
  });

  it('rejects pairs where amounts do not cancel', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-20', -19900)]],
      ['credit',   [tx('CC1', '2026-01-20', 15000)]],  // different amount
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(0);
  });

  it('ignores zero-amount transactions', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-20', 0)]],
      ['credit',   [tx('CC1', '2026-01-20', 0)]],
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(0);
  });

  it('each transaction matches at most once', () => {
    // Two credit txs with same amount — only one pair should form
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [tx('C1', '2026-01-20', -19900)]],
      ['credit',   [
        tx('CC1', '2026-01-20', 19900),
        tx('CC2', '2026-01-20', 19900),
      ]],
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(1);
  });

  it('three-account chain: each transaction matches at most once', () => {
    // A pays B, B pays C — B has two txs with the same amount (one in, one out).
    // The +10000 in B should pair with A's -10000, and B's -10000 should pair with C's +10000.
    const accountNames = new Map([['A', 'Account A'], ['B', 'Account B'], ['C', 'Account C']]);
    const txsByAccount = new Map<string, Tx[]>([
      ['A', [tx('A1', '2026-01-20', -10000)]],
      ['B', [tx('B1', '2026-01-20', 10000), tx('B2', '2026-01-21', -10000)]],
      ['C', [tx('C1', '2026-01-21', 10000)]],
    ]);
    const pairs = findTransferPairs(txsByAccount, accountNames);
    expect(pairs).toHaveLength(2);

    // Verify each transaction appears in at most one pair
    const usedIds = new Set<string>();
    for (const p of pairs) {
      expect(usedIds.has(p.outTx.id)).toBe(false);
      expect(usedIds.has(p.inTx.id)).toBe(false);
      usedIds.add(p.outTx.id);
      usedIds.add(p.inTx.id);
    }
  });

  it('handles multiple distinct pairs', () => {
    const txsByAccount = new Map<string, Tx[]>([
      ['checking', [
        tx('C1', '2026-01-20', -19900),
        tx('C2', '2026-02-01', -50000),
      ]],
      ['credit', [
        tx('CC1', '2026-01-20', 19900),
        tx('CC2', '2026-02-01', 50000),
      ]],
    ]);
    expect(findTransferPairs(txsByAccount, accountNames)).toHaveLength(2);
  });
});
