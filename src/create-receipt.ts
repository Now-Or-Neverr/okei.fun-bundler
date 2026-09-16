import type {Hash, PublicClient, TransactionReceipt} from 'viem';

import {receiptPollMs} from './config.js';

function isPendingReceiptError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes('could not be found') ||
    msg.includes('not be processed on a block yet') ||
    msg.includes('Transaction receipt')
  );
}

/** Poll until receipt exists — tolerates slow RPCs (no viem throw on pending). */
export async function waitForReceipt(
  publicClient: PublicClient,
  hash: Hash,
  label = 'tx',
): Promise<TransactionReceipt> {
  const pollMs = receiptPollMs();
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    try {
      const r = await publicClient.getTransactionReceipt({hash});
      if (r) return r;
    } catch (e) {
      if (!isPendingReceiptError(e)) throw e;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`${label} receipt timeout (${hash})`);
}

export const waitForCreateReceipt = waitForReceipt;
