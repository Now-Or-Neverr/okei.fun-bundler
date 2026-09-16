import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseEventLogs,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

import {okeiFactoryAbi} from './abis/factory.js';
import {GAS_LIMITS} from './config.js';
import type {Chain} from 'viem';
import {applySlippage, openingCurveFromParams, quoteBuy} from './curve.js';
import {
  encodeMetadata,
  gasForMetadata,
  parseDataUri,
  uriByteLength,
  type MetadataDraft,
} from './metadata.js';
import {ipfsToGatewayUrl} from './upload-logo.js';

const MAX_METADATA_BYTES = 1024;

function logoFieldsFromMetadataUri(
  metadataURI: string | undefined,
): Pick<LaunchResult, 'logoImage' | 'logoGatewayUrl'> {
  const uri = metadataURI?.trim();
  if (!uri) return {};
  const doc = parseDataUri(uri);
  const logoImage = doc?.image?.trim();
  if (!logoImage) return {};
  const logoGatewayUrl = logoImage.startsWith('ipfs://')
    ? ipfsToGatewayUrl(logoImage)
    : logoImage.startsWith('https://')
      ? logoImage
      : undefined;
  return {logoImage, logoGatewayUrl};
}

export type Venue = 'okeiswap' | 'uniswap';

export type BundleBuyLeg = {
  /** USDC amount for this leg (human, e.g. "0.5"). One payer — needs ATOMIC_LAUNCH_ADDRESS. */
  usdc: string;
  /** Defaults to beneficiary / bot wallet. */
  recipient?: `0x${string}`;
};

/** Each leg is paid by its own wallet (same-block multi-tx, not one tx). */
export type WalletBuyLeg = {
  usdc: string;
  /** Index into BUNDLER_WALLET_KEYS (comma-separated in .env). */
  keyIndex?: number;
  /** Optional override; prefer keyIndex + env for production. */
  privateKey?: `0x${string}`;
  /** Token recipient; defaults to the buyer address. */
  recipient?: `0x${string}`;
};

export type LaunchRequest = {
  name: string;
  symbol: string;
  metadata?: MetadataDraft;
  metadataURI?: string;
  /** Opening buy in USDC (human, e.g. "1.5"). Added on top of creation fee. */
  initialBuyUsdc?: string;
  venue?: Venue;
  slippageBps?: number;
  /** Extra curve buys in the same tx as create (requires ATOMIC_LAUNCH_ADDRESS). */
  bundleBuys?: BundleBuyLeg[];
  /** N funded wallets each pay their own buy tx; best-effort same block as create. */
  walletBuys?: WalletBuyLeg[];
  /**
   * Delay multiplier before wallet buys (0 = same-block burst with create).
   * With default time-based timing: wait blocksAfterCreate × BUNDLER_BLOCK_TIME_MS after create confirms.
   */
  blocksAfterCreate?: number;
  /** Who receives dev-buy tokens + refunds; defaults to bot wallet. */
  beneficiary?: `0x${string}`;
  /** Local path to logo (PNG/JPEG/WebP/GIF, max 2MB) — pinned to IPFS before launch. */
  logoFile?: string;
};

export type LaunchResult = {
  token: `0x${string}`;
  curve: `0x${string}`;
  tokensOut: bigint;
  txHash: Hash;
  creator: `0x${string}`;
  /** Present when launch used OkeiAtomicLaunch (on-chain OkeiToken.creator). */
  onChainCreator?: `0x${string}`;
  atomic?: boolean;
  mode?: 'direct' | 'atomic' | 'same-block';
  createTxHash?: Hash;
  buyTxHashes?: Hash[];
  sameBlock?: boolean;
  createFirstInBlock?: boolean;
  blockNumbers?: number[];
  blocksAfterCreate?: number;
  createBlockNumber?: number;
  bundleBlockNumber?: number;
  hitBundleBlock?: boolean;
  bundleTiming?: 'time' | 'block';
  bundleDelayMs?: number;
  monitorId?: string;
  monitorVerdict?: 'ok' | 'warning' | 'failed';
  /** Resolved from encoded metadata after logo upload (if any). */
  logoImage?: string;
  logoGatewayUrl?: string;
};

export type LaunchClients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  factory: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  chain: Chain;
  rpcUrl: string;
};

export function createLaunchClients(
  rpcUrl: string,
  privateKey: `0x${string}`,
  factory: `0x${string}`,
  chain: Chain,
) {
  const account = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({chain, transport});
  const walletClient = createWalletClient({chain, transport, account});
  return {publicClient, walletClient, factory, account, chain, rpcUrl };
}

const SYMBOL_PATTERN = /^[A-Za-z0-9]{1,11}$/;

export function validateLaunchRequest(req: LaunchRequest): string | null {
  const legacy = req as LaunchRequest & {targetBlockNumber?: number};
  if (legacy.targetBlockNumber != null) {
    return (
      'targetBlockNumber is no longer supported — use blocksAfterCreate instead ' +
      '(0 = same block as create, 1 = next block after create, etc.)'
    );
  }
  if (!req.name?.trim()) return 'name is required';
  if (!SYMBOL_PATTERN.test(req.symbol ?? '')) return 'symbol must be 1–11 alphanumeric';
  for (const leg of req.bundleBuys ?? []) {
    if (!leg.usdc?.trim() || Number(leg.usdc) <= 0) return 'each bundleBuys leg needs positive usdc';
  }
  for (const leg of req.walletBuys ?? []) {
    if (!leg.usdc?.trim() || Number(leg.usdc) <= 0) return 'each walletBuys leg needs positive usdc';
  }
  if ((req.bundleBuys?.length ?? 0) > 0 && (req.walletBuys?.length ?? 0) > 0) {
    return 'use either bundleBuys (one tx) or walletBuys (multi-wallet), not both';
  }
  if (req.blocksAfterCreate != null) {
    if (!Number.isInteger(req.blocksAfterCreate) || req.blocksAfterCreate < 0) {
      return 'blocksAfterCreate must be a non-negative integer';
    }
    if ((req.walletBuys?.length ?? 0) === 0) {
      return 'blocksAfterCreate requires walletBuys';
    }
  }
  const metadataURI =
    req.metadataURI?.trim() ||
    encodeMetadata(req.metadata ?? {});
  if (metadataURI && uriByteLength(metadataURI) > MAX_METADATA_BYTES) {
    return `metadata exceeds ${MAX_METADATA_BYTES} bytes (okei.fun limit)`;
  }
  return null;
}

export async function launchToken(
  clients: LaunchClients,
  req: LaunchRequest,
  opts?: {atomicLaunch?: `0x${string}`; walletKeyPool?: `0x${string}`[]},
): Promise<LaunchResult> {
  const {prepareLaunchRequest} = await import('./prepare-launch.js');
  const prepared = await prepareLaunchRequest(req);
  const err = validateLaunchRequest(prepared);
  if (err) throw new Error(err);
  req = prepared;

  const walletLegs = req.walletBuys?.length ?? 0;
  if (walletLegs > 0) {
    const pool = opts?.walletKeyPool ?? [];
    if (pool.length === 0 && !req.walletBuys!.every((l) => l.privateKey)) {
      throw new Error(
        'walletBuys requires BUNDLER_WALLET_KEYS in .env or privateKey on each leg',
      );
    }
    const {launchSameBlockMultiWallet} = await import('./same-block-launch.js');
    const result = await launchSameBlockMultiWallet(clients, req, pool);
    return {
      token: result.token,
      curve: result.curve,
      tokensOut: result.tokensOut,
      txHash: result.txHash,
      creator: result.creator,
      mode: 'same-block',
      createTxHash: result.createTxHash,
      buyTxHashes: result.buyTxHashes,
      sameBlock: result.sameBlock,
      createFirstInBlock: result.createFirstInBlock,
      blockNumbers: result.blockNumbers,
      blocksAfterCreate: result.blocksAfterCreate,
      createBlockNumber: result.createBlockNumber,
      bundleBlockNumber: result.bundleBlockNumber,
      hitBundleBlock: result.hitBundleBlock,
      bundleTiming: result.bundleTiming,
      bundleDelayMs: result.bundleDelayMs,
      ...logoFieldsFromMetadataUri(req.metadataURI),
    };
  }

  const extraLegs = req.bundleBuys?.length ?? 0;
  if (extraLegs > 0) {
    if (!opts?.atomicLaunch) {
      throw new Error(
        'bundleBuys requires ATOMIC_LAUNCH_ADDRESS — deploy contracts/OkeiAtomicLaunch.sol and set env',
      );
    }
    const {launchTokenAtomic} = await import('./atomic-launch.js');
    const result = await launchTokenAtomic({...clients, atomicLaunch: opts.atomicLaunch}, req);
    return {
      token: result.token,
      curve: result.curve,
      tokensOut: result.tokensOut,
      txHash: result.txHash,
      creator: result.beneficiary,
      onChainCreator: result.onChainCreator,
      atomic: true,
      mode: 'atomic',
      ...logoFieldsFromMetadataUri(req.metadataURI),
    };
  }

  const {publicClient, walletClient, factory, account, chain} = clients;
  const name = req.name.trim();
  const symbol = req.symbol.toUpperCase();
  const metadataURI = req.metadataURI?.trim() ?? encodeMetadata(req.metadata ?? {});
  const venue = req.venue === 'uniswap' ? 1 : 0;
  const slippageBps = req.slippageBps ?? 300;

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

  const buyAmount = req.initialBuyUsdc?.trim()
    ? parseEther(req.initialBuyUsdc.trim())
    : 0n;

  const preview = openingCurveFromParams(params);
  const quote = buyAmount > 0n ? quoteBuy(preview, buyAmount) : undefined;
  const minTokensOut =
    quote && buyAmount > 0n ? applySlippage(quote.tokensOut, slippageBps) : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const value = creationFee + buyAmount;
  const gas = GAS_LIMITS.createToken + gasForMetadata(metadataURI);

  const hash = await walletClient.writeContract({
    chain,
    account,
    address: factory,
    abi: okeiFactoryAbi,
    functionName: 'createToken',
    args: [name, symbol, metadataURI, venue, minTokensOut, deadline],
    value,
    gas,
  });

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (receipt.status !== 'success') {
    throw new Error(`createToken reverted (tx ${hash})`);
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
    tokensOut: quote?.tokensOut ?? 0n,
    txHash: hash,
    creator: account.address,
    mode: 'direct',
    ...logoFieldsFromMetadataUri(metadataURI),
  };
}
