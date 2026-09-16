import {
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Hash,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

import {okeiCurveAbi} from './abis/curve.js';
import {okeiFactoryAbi} from './abis/factory.js';
import {GAS_LIMITS} from './config.js';
import {
  applySlippage,
  curveAfterBuy,
  DEFAULT_SLIPPAGE_BPS,
  openingCurveFromParams,
  quoteBuy,
  type CurveState,
} from './curve.js';
import {readCurveState} from './curve-onchain.js';
import {encodeMetadata, gasForMetadata} from './metadata.js';
import type {LaunchClients, LaunchRequest, WalletBuyLeg} from './launch.js';
import {waitForCreateReceipt, waitForReceipt} from './create-receipt.js';
import {predictCreateTokenAddresses} from './predict-curve.js';
import {
  blockWaitPollMs,
  bundleDelayMs,
  bundleTiming,
  receiptPollMs,
} from './config.js';
import {waitUntilMinBlock} from './wait-block.js';

export type SameBlockLaunchResult = {
  token: `0x${string}`;
  curve: `0x${string}`;
  tokensOut: bigint;
  txHash: Hash;
  creator: `0x${string}`;
  mode: 'same-block';
  createTxHash: Hash;
  buyTxHashes: Hash[];
  predictedCurve: `0x${string}`;
  blockNumbers: number[];
  sameBlock: boolean;
  createFirstInBlock: boolean;
  blocksAfterCreate?: number;
  createBlockNumber?: number;
  bundleBlockNumber?: number;
  hitBundleBlock?: boolean;
  bundleTiming?: 'time' | 'block';
  bundleDelayMs?: number;
};

export type WalletKeyPool = `0x${string}`[];

export function resolveWalletBuyKey(
  leg: WalletBuyLeg,
  pool: WalletKeyPool,
): `0x${string}` {
  if (leg.privateKey) return leg.privateKey;
  if (leg.keyIndex == null || leg.keyIndex < 0 || leg.keyIndex >= pool.length) {
    throw new Error(
      `walletBuys leg needs privateKey or valid keyIndex (0..${pool.length - 1})`,
    );
  }
  return pool[leg.keyIndex]!;
}

function buildBuyPlansFromState(
  legs: WalletBuyLeg[],
  walletPool: WalletKeyPool,
  initialState: CurveState,
  slippageBps: number,
) {
  let curveState = initialState;
  let totalTokensOut = 0n;
  const buyPlans: {
    account: ReturnType<typeof privateKeyToAccount>;
    usdcIn: bigint;
    minTokensOut: bigint;
    recipient: `0x${string}`;
  }[] = [];

  for (const leg of legs) {
    const pk = resolveWalletBuyKey(leg, walletPool);
    const buyer = privateKeyToAccount(pk);
    const usdcIn = parseEther(leg.usdc.trim());
    const q = quoteBuy(curveState, usdcIn);
    const minTokensOut = applySlippage(q.tokensOut, slippageBps);
    totalTokensOut += q.tokensOut;
    curveState = curveAfterBuy(curveState, usdcIn);
    buyPlans.push({
      account: buyer,
      usdcIn,
      minTokensOut,
      recipient: (leg.recipient ?? buyer.address) as `0x${string}`,
    });
  }
  return {buyPlans, totalTokensOut};
}

export async function launchSameBlockMultiWallet(
  clients: LaunchClients,
  req: LaunchRequest,
  walletPool: WalletKeyPool,
): Promise<SameBlockLaunchResult> {
  const legs = req.walletBuys ?? [];
  if (legs.length === 0) {
    throw new Error('walletBuys required for same-block multi-wallet launch');
  }

  const blocksAfterCreate = req.blocksAfterCreate ?? 0;
  if (!Number.isInteger(blocksAfterCreate) || blocksAfterCreate < 0) {
    throw new Error('blocksAfterCreate must be a non-negative integer');
  }

  const {publicClient, walletClient, factory, account, chain, rpcUrl} = clients;

  const name = req.name.trim();
  const symbol = req.symbol.toUpperCase();
  const metadataURI = req.metadataURI?.trim() ?? encodeMetadata(req.metadata ?? {});
  const venue = req.venue === 'uniswap' ? 1 : 0;
  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

  const [creationFee, params] = await Promise.all([
    publicClient.readContract({
      address: factory,
      abi: okeiFactoryAbi,
      functionName: 'creationFee',
    }),
    publicClient.readContract({
      address: factory,
      abi: okeiFactoryAbi,
      functionName: 'defaultParams',
    }),
  ]);

  const devBuy = req.initialBuyUsdc?.trim() ? parseEther(req.initialBuyUsdc.trim()) : 0n;
  let preview = openingCurveFromParams(params);
  const devQuote = devBuy > 0n ? quoteBuy(preview, devBuy) : undefined;
  const minTokensOutFirst =
    devQuote && devBuy > 0n ? applySlippage(devQuote.tokensOut, slippageBps) : 0n;
  let totalTokensOut = devQuote?.tokensOut ?? 0n;
  if (devQuote) preview = curveAfterBuy(preview, devBuy);

  const createValue = creationFee + devBuy;
  const createGas = GAS_LIMITS.createToken + gasForMetadata(metadataURI);
  const buyGas = GAS_LIMITS.curveBuy;

  /** Delayed bundle: create first, then wallet buys N blocks later. */
  if (blocksAfterCreate > 0) {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const fees = await publicClient.estimateFeesPerGas();

    const createHash = await walletClient.writeContract({
      chain,
      account,
      address: factory,
      abi: okeiFactoryAbi,
      functionName: 'createToken',
      args: [name, symbol, metadataURI, venue, minTokensOutFirst, deadline],
      value: createValue,
      gas: createGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 1_000_000_000n,
    });

    const createReceipt = await waitForCreateReceipt(publicClient, createHash);
    if (createReceipt.status !== 'success') {
      throw new Error(`createToken reverted (tx ${createHash})`);
    }

    const [created] = parseEventLogs({
      abi: okeiFactoryAbi,
      eventName: 'TokenCreated',
      logs: createReceipt.logs,
    });
    if (!created) throw new Error(`TokenCreated not found in ${createHash}`);

    const curve = created.args.curve;
    const createBlockNumber = Number(createReceipt.blockNumber);
    const bundleBlockNumber = createBlockNumber + blocksAfterCreate;

    const timing = bundleTiming();
    const delayMs = bundleDelayMs(blocksAfterCreate);
    let missedExactBlock = false;

    if (timing === 'time') {
      console.log(
        `[bundler] create block ${createBlockNumber}; waiting ${delayMs}ms (${blocksAfterCreate} × ${delayMs / blocksAfterCreate}ms/block) before wallet buys`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    } else {
      console.log(
        `[bundler] token created in block ${createBlockNumber}; bundle target block ${bundleBlockNumber} (+${blocksAfterCreate})`,
      );
      const headNow = await publicClient.getBlockNumber();
      missedExactBlock = headNow > BigInt(bundleBlockNumber);
      if (headNow < BigInt(bundleBlockNumber)) {
        const wait = await waitUntilMinBlock(publicClient, BigInt(bundleBlockNumber), {
          pollMs: blockWaitPollMs(),
          onTick: (head) => {
            if (head >= BigInt(bundleBlockNumber) - 1n) {
              console.log(`[bundler] waiting for bundle block ${bundleBlockNumber} (head ${head})`);
            }
          },
        });
        missedExactBlock = wait.missedExactBlock;
      }
      if (missedExactBlock) {
        console.warn(
          `[bundler] late for bundle block ${bundleBlockNumber} — submitting buys immediately`,
        );
      }
    }

    const buyDeadline = BigInt(Math.floor(Date.now() / 1000) + 900);
    const [buyFees, curveState] = await Promise.all([
      publicClient.estimateFeesPerGas(),
      readCurveState(publicClient, curve),
    ]);
    const {buyPlans, totalTokensOut: buyTokens} = buildBuyPlansFromState(
      legs,
      walletPool,
      curveState,
      slippageBps,
    );
    totalTokensOut = (devQuote?.tokensOut ?? 0n) + buyTokens;

    const buyTxHashes = await Promise.all(
      buyPlans.map((plan) => {
        const wc = createWalletClient({
          chain,
          transport: http(rpcUrl),
          account: plan.account,
        });
        return wc.writeContract({
          chain,
          account: plan.account,
          address: curve,
          abi: okeiCurveAbi,
          functionName: 'buy',
          args: [plan.minTokensOut, plan.recipient, buyDeadline],
          value: plan.usdcIn,
          gas: buyGas,
          maxFeePerGas: buyFees.maxFeePerGas,
          maxPriorityFeePerGas: buyFees.maxPriorityFeePerGas ?? 1_000_000_000n,
        });
      }),
    );

    const buyReceipts = await Promise.all(
      buyTxHashes.map((h) => waitForReceipt(publicClient, h, 'buy')),
    );
    const failedBuy = buyReceipts.find((r) => r.status !== 'success');
    if (failedBuy) {
      throw new Error(`a wallet buy reverted in block ${failedBuy.blockNumber}`);
    }

    const buyBlocks = buyReceipts.map((r) => Number(r.blockNumber));
    const hitBundleBlock = buyBlocks.every((b) => b === bundleBlockNumber);
    if (!hitBundleBlock) {
      console.warn(
        `[bundler] bundle target block ${bundleBlockNumber} missed — buys in ${buyBlocks.join(',')}`,
      );
    }

    const blockNumbers = [createBlockNumber, ...buyBlocks];
    const sameBlock = blockNumbers.every((b) => b === blockNumbers[0]);

    return {
      token: created.args.token,
      curve,
      tokensOut: totalTokensOut,
      txHash: createHash,
      creator: account.address,
      mode: 'same-block',
      createTxHash: createHash,
      buyTxHashes,
      predictedCurve: curve,
      blockNumbers,
      sameBlock,
      createFirstInBlock: false,
      blocksAfterCreate,
      createBlockNumber,
      bundleBlockNumber,
      hitBundleBlock,
      bundleTiming: timing,
      bundleDelayMs: timing === 'time' ? delayMs : undefined,
    };
  }

  /** blocksAfterCreate === 0: create + buys in one burst (same block best-effort). */
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const {buyPlans, totalTokensOut: bundleTokens} = buildBuyPlansFromState(
    legs,
    walletPool,
    preview,
    slippageBps,
  );
  totalTokensOut = (devQuote?.tokensOut ?? 0n) + bundleTokens;

  const {curve: predictedCurve} = await predictCreateTokenAddresses(publicClient, factory);

  const fees = await publicClient.estimateFeesPerGas();
  const createTip = fees.maxPriorityFeePerGas ?? 1_000_000_000n;
  const buyTip =
    createTip > 2_000_000_000n ? createTip - 1_000_000_000n : createTip / 2n;

  const createHash = await walletClient.writeContract({
    chain,
    account,
    address: factory,
    abi: okeiFactoryAbi,
    functionName: 'createToken',
    args: [name, symbol, metadataURI, venue, minTokensOutFirst, deadline],
    value: createValue,
    gas: createGas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: createTip,
  });

  const buyTxPromises = buyPlans.map((plan) => {
    const wc = createWalletClient({
      chain,
      transport: http(rpcUrl),
      account: plan.account,
    });
    return wc.writeContract({
      chain,
      account: plan.account,
      address: predictedCurve,
      abi: okeiCurveAbi,
      functionName: 'buy',
      args: [plan.minTokensOut, plan.recipient, deadline],
      value: plan.usdcIn,
      gas: buyGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: buyTip,
    });
  });

  const buyTxHashes = await Promise.all(buyTxPromises);

  const allHashes = [createHash, ...buyTxHashes];
  const receipts = await Promise.all(
    allHashes.map((h) => publicClient.waitForTransactionReceipt({hash: h})),
  );

  const createReceipt = receipts[0]!;
  if (createReceipt.status !== 'success') {
    throw new Error(`createToken reverted (tx ${createHash})`);
  }

  const [created] = parseEventLogs({
    abi: okeiFactoryAbi,
    eventName: 'TokenCreated',
    logs: createReceipt.logs,
  });
  if (!created) {
    throw new Error(`TokenCreated not found in ${createHash}`);
  }

  if (created.args.curve.toLowerCase() !== predictedCurve.toLowerCase()) {
    throw new Error(
      `curve prediction mismatch: expected ${predictedCurve}, got ${created.args.curve}`,
    );
  }

  const buyReceipts = receipts.slice(1);
  const failedBuy = buyReceipts.find((r) => r.status !== 'success');
  if (failedBuy) {
    throw new Error(`a wallet buy reverted in block ${failedBuy.blockNumber}`);
  }

  const blockNumbers = receipts.map((r) => Number(r.blockNumber));
  const sameBlock = blockNumbers.every((b) => b === blockNumbers[0]);
  const createIndex = createReceipt.transactionIndex;
  const createFirstInBlock = buyReceipts.every(
    (r) => Number(r.transactionIndex) > Number(createIndex),
  );
  const createBlockNumber = Number(createReceipt.blockNumber);

  return {
    token: created.args.token,
    curve: created.args.curve,
    tokensOut: totalTokensOut,
    txHash: createHash,
    creator: account.address,
    mode: 'same-block',
    createTxHash: createHash,
    buyTxHashes,
    predictedCurve,
    blockNumbers,
    sameBlock,
    createFirstInBlock,
    blocksAfterCreate: 0,
    createBlockNumber,
    bundleBlockNumber: sameBlock ? createBlockNumber : undefined,
    hitBundleBlock: sameBlock ? true : undefined,
  };
}
