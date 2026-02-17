import { readFileSync } from 'fs';
import type { RawTransaction } from '../types.js';

export function parseQfx(filepath: string): RawTransaction[] {
  const content = readFileSync(filepath, 'utf-8');
  const acctId = content.match(/<ACCTID>([^\n<]+)/)?.[1]?.trim() ?? 'unknown';
  const transactions: RawTransaction[] = [];

  for (const block of content.split('<STMTTRN>').slice(1)) {
    const id     = block.match(/<FITID>([^\n<]+)/)?.[1]?.trim();
    const name   = block.match(/<NAME>([^\n<]+)/)?.[1]?.trim();
    const amount = block.match(/<TRNAMT>([^\n<]+)/)?.[1]?.trim();
    const date   = block.match(/<DTPOSTED>([^\n<]+)/)?.[1]?.trim();

    if (id && name && amount && date) {
      transactions.push({
        id,
        date: date.slice(0, 8),
        amount: parseFloat(amount),
        rawPayee: name,
        account: acctId,
      });
    }
  }

  return transactions;
}

export function parseQfxFiles(filepaths: string[]): RawTransaction[] {
  return filepaths.flatMap(parseQfx);
}
