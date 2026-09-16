import {parseEther, parseEventLogs, type Hash} from 'viem';

import {okeiAtomicLaunchAbi} from './abis/atomic-launch.js';
import {okeiFactoryAbi} from './abis/factory.js';
import {GAS_LIMITS} from './config.js';
import type {Chain} from 'viem';
import {applySlippage, curveAfterBuy, DEFAULT_SLIPPAGE_BPS, openingCurveFromParams, quoteBuy} from './curve.js';
import {encodeMetadata, gasForMetadata} from './metadata.js';
import type {LaunchClients} from './launch.js';
import type {BundleBuyLeg, LaunchRequest} from './launch.js';

export type AtomicLaunchClients = LaunchClients & {
  atomicLaunch: `0x${string}`;
};

export async function launchTokenAtomic(
  clients: AtomicLaunchClients,
  req: LaunchRequest,
): Promise<{
  token: `0x${string}`;
  curve: `0x${string}`;
  tokensOut: bigint;
  txHash: Hash;
  creator: `0x${string}`;
  beneficiary: `0x${string}`;
  onChainCreator: `0x${string}`;
  legs: {usdcIn: bigint; minTokensOut: bigint; recipient: `0x${string}`}[];
}> {
  const {publicClient, walletClient, factory, account, chain, atomicLaunch} = clients;
  const name = req.name.trim();
  const symbol = req.symbol.toUpperCase();
  const metadataURI = req.metadataURI?.trim() ?? encodeMetadata(req.metadata ?? {});
  const venue = req.venue === 'uniswap' ? 1 : 0;
  const slippageBps = req.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const beneficiary = (req.beneficiary ?? account.address) as `0x${string}`;
  const extrasReq = req.bundleBuys ?? [];

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

  const firstBuy = req.initialBuyUsdc?.trim() ? parseUsdc(req.initialBuyUsdc.trim()) : 0n;

  let curve = openingCurveFromParams(params);
  const legs: {usdcIn: bigint; minTokensOut: bigint; recipient: `0x${string}`}[] = [];

  let firstMin = 0n;
  let totalTokensOut = 0n;
  if (firstBuy > 0n) {
    const q = quoteBuy(curve, firstBuy);
    firstMin = applySlippage(q.tokensOut, slippageBps);
    totalTokensOut += q.tokensOut;
    curve = curveAfterBuy(curve, firstBuy);
  }

  for (const leg of extrasReq) {
    const usdcIn = parseUsdc(leg.usdc);
    const recipient = (leg.recipient ?? beneficiary) as `0x${string}`;
    const q = quoteBuy(curve, usdcIn);
    const minTokensOut = applySlippage(q.tokensOut, slippageBps);
    totalTokensOut += q.tokensOut;
    curve = curveAfterBuy(curve, usdcIn);
    legs.push({usdcIn, minTokensOut, recipient});
  }

  let extrasTotal = 0n;
  for (const leg of legs) extrasTotal += leg.usdcIn;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const value = creationFee + firstBuy + extrasTotal;
  const gas =
    GAS_LIMITS.atomicLaunch +
    BigInt(legs.length) * GAS_LIMITS.atomicLaunchBuyLeg +
    gasForMetadata(metadataURI);

  const hash = await walletClient.writeContract({
    chain,
    account,
    address: atomicLaunch,
    abi: okeiAtomicLaunchAbi,
    functionName: 'launch',
    args: [
      name,
      symbol,
      metadataURI,
      venue,
      firstMin,
      beneficiary,
      legs,
      deadline,
    ],
    value,
    gas,
  });

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`atomic launch reverted (tx ${hash})`);
  }

  const [created] = parseEventLogs({
    abi: okeiFactoryAbi,
    eventName: 'TokenCreated',
    logs: receipt.logs,
  });

  if (!created) {
    throw new Error(`TokenCreated not found in receipt ${hash}`);
  }

  return {
    token: created.args.token,
    curve: created.args.curve,
    tokensOut: totalTokensOut,
    txHash: hash,
    creator: account.address,
    beneficiary,
    onChainCreator: created.args.creator,
    legs,
  };
}

function parseUsdc(human: string): bigint {
  return parseEther(human);
}
