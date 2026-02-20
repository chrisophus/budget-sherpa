import { describe, it, expect } from 'vitest';
import { buildTxPayload } from './session.js';
import type { RawTransaction } from '../types.js';

function makeTx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    id: 'TX001',
    date: '20260115',
    amount: -199.00,
    rawPayee: 'AMAZON MKTPL 12345',
    account: 'ACCT001',
    ...overrides,
  };
}

const noTag = () => null;
const noCat = () => null;

describe('buildTxPayload', () => {
  it('converts amount from dollars to cents', () => {
    const tx = makeTx({ amount: -199.00 });
    const result = buildTxPayload(tx, new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(-19900);
  });

  it('converts positive amount correctly', () => {
    const result = buildTxPayload(makeTx({ amount: 1234.56 }), new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(123456);
  });

  it('rounds sub-cent amounts', () => {
    // Some banks emit amounts like -5.999 due to FX; should round to nearest cent
    const result = buildTxPayload(makeTx({ amount: -5.999 }), new Map(), noTag, noCat, new Map());
    expect(result.amount).toBe(-600);
  });

  it('converts date from YYYYMMDD to YYYY-MM-DD', () => {
    const result = buildTxPayload(makeTx({ date: '20260315' }), new Map(), noTag, noCat, new Map());
    expect(result.date).toBe('2026-03-15');
  });

  it('sets payee_name when cleanPayee is found', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const result = buildTxPayload(makeTx(), payeeMap, noTag, noCat, new Map());
    expect(result.payee_name).toBe('Amazon');
  });

  it('omits payee_name when no mapping exists', () => {
    const result = buildTxPayload(makeTx(), new Map(), noTag, noCat, new Map());
    expect(result).not.toHaveProperty('payee_name');
  });

  it('sets category when lookup returns a known category', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const categoryLookup = (p: string) => p === 'Amazon' ? 'Shopping' : null;
    const categoryIdByName = new Map([['shopping', 'cat-123']]);
    const result = buildTxPayload(makeTx(), payeeMap, noTag, categoryLookup, categoryIdByName);
    expect(result.category).toBe('cat-123');
  });

  it('omits category when category name not found in Actual', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const categoryLookup = () => 'Shopping';
    const result = buildTxPayload(makeTx(), payeeMap, noTag, categoryLookup, new Map()); // empty id map
    expect(result).not.toHaveProperty('category');
  });

  it('sets notes tag when tagLookup returns a value', () => {
    const payeeMap = new Map([['AMAZON MKTPL 12345', 'Amazon']]);
    const tagLookup = (p: string) => p === 'Amazon' ? 'discretionary' : null;
    const result = buildTxPayload(makeTx(), payeeMap, tagLookup, noCat, new Map());
    expect(result.notes).toBe('#discretionary');
  });

  it('omits notes when no tag', () => {
    const result = buildTxPayload(makeTx(), new Map(), noTag, noCat, new Map());
    expect(result).not.toHaveProperty('notes');
  });

  it('always sets imported_id and imported_payee', () => {
    const result = buildTxPayload(makeTx({ id: 'FIT123', rawPayee: 'WALMART' }), new Map(), noTag, noCat, new Map());
    expect(result.imported_id).toBe('FIT123');
    expect(result.imported_payee).toBe('WALMART');
  });
});
