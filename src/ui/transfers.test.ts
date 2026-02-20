import { describe, it, expect } from 'vitest';
import { findTransferPairs, daysBetween, DATE_TOLERANCE_DAYS } from './transfers.js';

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
