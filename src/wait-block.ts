import type {PublicClient} from 'viem';

import {blockWaitPollMs} from './config.js';

/** Wait until chain head >= minBlock, then return (never throws if head already past minBlock). */
export async function waitUntilMinBlock(
  publicClient: PublicClient,
  minBlock: bigint,
  opts?: {pollMs?: number; onTick?: (head: bigint) => void},
): Promise<{headAtSubmit: bigint; missedExactBlock: boolean}> {
  const pollMs = opts?.pollMs ?? blockWaitPollMs();

  while (true) {
    const head = await publicClient.getBlockNumber();
    opts?.onTick?.(head);

    if (head >= minBlock) {
      return {headAtSubmit: head, missedExactBlock: head > minBlock};
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function waitToSubmitForTargetBlock(
  publicClient: PublicClient,
  targetBlock: bigint,
  opts?: {pollMs?: number; onTick?: (head: bigint) => void},
): Promise<{headAtSubmit: bigint}> {
  const pollMs = opts?.pollMs ?? 250;

  while (true) {
    const head = await publicClient.getBlockNumber();
    opts?.onTick?.(head);

    if (head > targetBlock) {
      throw new Error(
        `bundle block ${targetBlock} already passed (chain head ${head}) — ` +
          'use blocksAfterCreate from the create block, not a fixed block number in JSON',
      );
    }

    // Fire while head is target-1 so txs are mined in target, or at target if we are already there.
    if (head === targetBlock || head === targetBlock - 1n) {
      return {headAtSubmit: head};
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
