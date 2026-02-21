import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseQfx, parseQfxFiles, parseQfxMeta } from './qfx.js';

// Minimal QFX fixture builder
function makeQfx(opts: {
  acctId?: string;
  acctType?: string;
  isCredit?: boolean;
  transactions?: Array<{ id: string; name: string; amount: string; date: string }>;
}): string {
  const acctId = opts.acctId ?? 'TEST1234';
  const txBlocks = (opts.transactions ?? [])
    .map(t => `<STMTTRN>\n<FITID>${t.id}\n<NAME>${t.name}\n<TRNAMT>${t.amount}\n<DTPOSTED>${t.date}\n</STMTTRN>`)
    .join('\n');

  if (opts.isCredit) {
    return `<CCACCTFROM>\n<ACCTID>${acctId}\n</CCACCTFROM>\n${txBlocks}`;
  }
  return `<BANKACCTFROM>\n<ACCTID>${acctId}\n<ACCTTYPE>${opts.acctType ?? 'CHECKING'}\n</BANKACCTFROM>\n${txBlocks}`;
}

function withTempFile(content: string, fn: (path: string) => void) {
  const path = join(tmpdir(), `test-${Date.now()}.qfx`);
  writeFileSync(path, content, 'utf-8');
  try { fn(path); } finally { unlinkSync(path); }
}

describe('parseQfx', () => {
  it('parses a single transaction correctly', () => {
    const qfx = makeQfx({
      acctId: 'ACCT001',
      transactions: [{ id: 'TX1', name: 'AMAZON MKTPL', amount: '-42.99', date: '20260115120000' }],
    });
    withTempFile(qfx, path => {
      const txs = parseQfx(path);
      expect(txs).toHaveLength(1);
      expect(txs[0]).toMatchObject({
        id: 'TX1',
        rawPayee: 'AMAZON MKTPL',
        amount: -42.99,
        date: '20260115',
        account: 'ACCT001',
      });
    });
  });

  it('parses multiple transactions', () => {
    const qfx = makeQfx({
      transactions: [
        { id: 'T1', name: 'STARBUCKS', amount: '-5.75', date: '20260101' },
        { id: 'T2', name: 'PAYROLL', amount: '2500.00', date: '20260115' },
      ],
    });
    withTempFile(qfx, path => {
      const txs = parseQfx(path);
      expect(txs).toHaveLength(2);
      expect(txs[0].amount).toBe(-5.75);
      expect(txs[1].amount).toBe(2500);
    });
  });

  it('truncates date to YYYYMMDD', () => {
    const qfx = makeQfx({
      transactions: [{ id: 'T1', name: 'FOO', amount: '-1.00', date: '20260315120000[+0:GMT]' }],
    });
    withTempFile(qfx, path => {
      expect(parseQfx(path)[0].date).toBe('20260315');
    });
  });

  it('returns empty array when no transactions', () => {
    const qfx = makeQfx({});
    withTempFile(qfx, path => {
      expect(parseQfx(path)).toHaveLength(0);
    });
  });

  it('handles Capital One XML format (closing tags)', () => {
    // Capital One emits <TRNAMT>-36.00</TRNAMT> with closing tag and leading whitespace
    const qfx = `<CCACCTFROM>\n<ACCTID>CC5678\n</CCACCTFROM>\n` +
      `<STMTTRN>\n    <FITID>TX1\n    <NAME>NETFLIX</TRNNAME>\n    <TRNAMT>-15.99</TRNAMT>\n    <DTPOSTED>20260115</DTPOSTED>\n</STMTTRN>`;
    withTempFile(qfx, path => {
      const txs = parseQfx(path);
      expect(txs).toHaveLength(1);
      expect(txs[0].amount).toBe(-15.99);
    });
  });

  it('skips transactions with missing required fields', () => {
    // Transaction missing NAME field — should be skipped
    const qfx = makeQfx({
      transactions: [{ id: 'T1', name: 'VALID', amount: '-10.00', date: '20260101' }],
    }).replace('<NAME>VALID', ''); // remove NAME field
    withTempFile(qfx, path => {
      expect(parseQfx(path)).toHaveLength(0);
    });
  });
});

describe('parseQfx — robustness', () => {
  it('handles CRLF line endings (Windows)', () => {
    // Replace all \n with \r\n to simulate Windows file
    const qfx = makeQfx({
      acctId: 'CRLF001',
      transactions: [{ id: 'TX1', name: 'WALMART', amount: '-25.00', date: '20260201' }],
    }).replace(/\n/g, '\r\n');
    withTempFile(qfx, path => {
      const txs = parseQfx(path);
      expect(txs).toHaveLength(1);
      expect(txs[0].account).toBe('CRLF001');
      expect(txs[0].rawPayee).toBe('WALMART');
    });
  });

  it('parses amount with leading whitespace', () => {
    const qfx = makeQfx({
      transactions: [{ id: 'TX1', name: 'NETFLIX', amount: '   -15.99', date: '20260201' }],
    });
    withTempFile(qfx, path => {
      expect(parseQfx(path)[0].amount).toBe(-15.99);
    });
  });
});

describe('parseQfxFiles', () => {
  it('returns empty array for empty input', () => {
    expect(parseQfxFiles([])).toEqual([]);
  });
});

describe('parseQfxMeta', () => {
  it('detects credit card account', () => {
    const qfx = makeQfx({ acctId: 'CC5678', isCredit: true });
    withTempFile(qfx, path => {
      const [meta] = parseQfxMeta([path]);
      expect(meta.acctType).toBe('credit');
      expect(meta.lastFour).toBe('5678');
    });
  });

  it('detects checking account', () => {
    const qfx = makeQfx({ acctId: 'CHK0077', acctType: 'CHECKING' });
    withTempFile(qfx, path => {
      const [meta] = parseQfxMeta([path]);
      expect(meta.acctType).toBe('checking');
    });
  });

  it('detects savings account', () => {
    const qfx = makeQfx({ acctId: 'SAV9999', acctType: 'SAVINGS' });
    withTempFile(qfx, path => {
      const [meta] = parseQfxMeta([path]);
      expect(meta.acctType).toBe('savings');
    });
  });
});
