import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { ActualClient } from '../actual/client.js';

export const DATE_TOLERANCE_DAYS = 5;

export function daysBetween(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

// Exported for testing
export function findTransferPairs(
  txsByAccount: Map<string, Tx[]>,
  accountNames: Map<string, string>,
): TransferPair[] {
  const accountIds = [...txsByAccount.keys()];
  const pairs: TransferPair[] = [];
  const used = new Set<string>();

  for (let i = 0; i < accountIds.length; i++) {
    for (let j = i + 1; j < accountIds.length; j++) {
      const acctA = accountIds[i];
      const acctB = accountIds[j];
      const txsA = txsByAccount.get(acctA) ?? [];
      const txsB = txsByAccount.get(acctB) ?? [];

      for (const txA of txsA) {
        for (const txB of txsB) {
          if (
            used.has(txA.id) || used.has(txB.id) ||
            txA.amount === 0 ||
            txA.amount !== -txB.amount ||
            daysBetween(txA.date, txB.date) > DATE_TOLERANCE_DAYS
          ) continue;

          const [outTx, outAcctId, inTx, inAcctId] =
            txA.amount < 0
              ? [txA, acctA, txB, acctB]
              : [txB, acctB, txA, acctA];

          pairs.push({
            outTx, outAcctId,
            inTx, inAcctId,
            outAcctName: accountNames.get(outAcctId) ?? outAcctId,
            inAcctName: accountNames.get(inAcctId) ?? inAcctId,
          });
          used.add(txA.id);
          used.add(txB.id);
        }
      }
    }
  }
  return pairs;
}

export function formatAmount(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

interface Tx {
  id: string;
  date: string;
  amount: number;
  payee_name?: string;
  imported_payee?: string;
  transfer_id?: string | null;
}

interface TransferPair {
  outTx: Tx;        // negative (outflow) side
  inTx: Tx;         // positive (inflow) side
  outAcctId: string;
  inAcctId: string;
  outAcctName: string;
  inAcctName: string;
}

export async function detectAndLinkTransfers(
  accountIds: string[], // actual account IDs to scan
  actual: ActualClient,
  syncBatchSize = 5, // sync after this many linked pairs to keep payloads small
): Promise<void> {
  const accounts = await actual.getAccounts() as Array<{ id: string; name: string }>;
  const payees = await actual.getPayees() as Array<{ id: string; name: string; transfer_acct?: string }>;

  // Each account has a transfer payee whose transfer_acct points to that account.
  // This payee is used in *other* accounts to indicate "transfer to this account".
  const transferPayeeByAcct = new Map(
    payees
      .filter(p => p.transfer_acct)
      .map(p => [p.transfer_acct!, p])
  );

  const accountNames = new Map(accounts.map(a => [a.id, a.name]));
  const actualAccountIds = accountIds;

  // Fetch all unlinked transactions for each imported account
  const txsByAccount = new Map<string, Tx[]>();
  for (const accountId of actualAccountIds) {
    const txs = (await actual.getTransactions(accountId)) as Tx[];
    txsByAccount.set(accountId, txs.filter(tx => !tx.transfer_id));
  }

  // Find transfer candidates: pairs across accounts where amounts cancel
  // and dates are within the tolerance window
  const pairs = findTransferPairs(txsByAccount, accountNames);

  if (pairs.length === 0) {
    console.log(chalk.dim('  No transfer candidates found.'));
    return;
  }

  // Group by account pair for display
  const byPair = new Map<string, TransferPair[]>();
  for (const pair of pairs) {
    const key = `${pair.outAcctId}→${pair.inAcctId}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key)!.push(pair);
  }

  for (const groupPairs of byPair.values()) {
    const { outAcctName, inAcctName, outAcctId, inAcctId } = groupPairs[0];
    console.log(`\n  ${chalk.cyan(outAcctName)} → ${chalk.cyan(inAcctName)}`);
    console.log('  ' + '─'.repeat(50));

    for (const { outTx, inTx } of groupPairs) {
      const amount = formatAmount(outTx.amount).padStart(10);
      const outPayee = outTx.imported_payee ?? outTx.payee_name ?? '?';
      const inPayee  = inTx.imported_payee  ?? inTx.payee_name  ?? '?';
      const gap = daysBetween(outTx.date, inTx.date);
      const gapStr = gap > 0 ? chalk.dim(` +${gap}d`) : '';
      console.log(`  ${outTx.date}  ${amount}  ${chalk.dim(outPayee)} → ${chalk.dim(inPayee)}${gapStr}`);
    }

    const doLink = await confirm({
      message: `Link these ${groupPairs.length} pairs as transfers?`,
      default: true,
    });
    if (!doLink) continue;

    // Transfer payee for outAcct is used in inAcct's transaction (and vice versa)
    const inTransferPayee  = transferPayeeByAcct.get(inAcctId);  // points to in-account, used on out-tx
    const outTransferPayee = transferPayeeByAcct.get(outAcctId); // points to out-account, used on in-tx

    if (!inTransferPayee || !outTransferPayee) {
      console.log(chalk.yellow('  ⚠ Transfer payees not found — accounts may not support transfers'));
      continue;
    }

    let linked = 0;
    for (const { outTx, inTx } of groupPairs) {
      try {
        await actual.updateTransaction(outTx.id, {
          payee: inTransferPayee.id,
          transfer_id: inTx.id,
        });
        await actual.updateTransaction(inTx.id, {
          payee: outTransferPayee.id,
          transfer_id: outTx.id,
        });
        linked++;
        if (linked % syncBatchSize === 0) await actual.sync();
      } catch (err: any) {
        console.log(chalk.red(`  ✗ ${outTx.date} ${formatAmount(outTx.amount)}: ${err.message ?? err}`));
      }
    }
    console.log(chalk.green(`  ✓ Linked ${linked} of ${groupPairs.length} transfer pairs`));
  }
}
