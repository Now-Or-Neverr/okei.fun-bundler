import {config as loadDotenv} from 'dotenv';
import {defineChain, type Chain} from 'viem';

let dotenvLoaded = false;

function ensureDotenv() {
  if (dotenvLoaded) return;
  loadDotenv({path: '.env'});
  dotenvLoaded = true;
}

export const ARC_TESTNET_ID = 5042002;
export const ARC_MAINNET_ID = 5042;

/** Live [okei.fun](https://okei.fun) factory (stock $6k / $14k curve). Still chain 5042002. */
export const OKEI_FUN_FACTORY = '0x975F33Ebcc1514d5834Bf3C477c7A9F9d5Cc4856' as const;
/** Cheap faucet factory on [testnet.okei.fun](https://testnet.okei.fun) ($6 / $24 curve). */
export const OKEI_FUN_TESTNET_FAUCET_FACTORY =
  '0x05b6b26cd29a951a2ca47001ac8fc04ec471a412' as const;

export const arcTestnet = defineChain({
  id: ARC_TESTNET_ID,
  name: 'Arc Testnet',
  nativeCurrency: {name: 'USD Coin', symbol: 'USDC', decimals: 18},
  rpcUrls: {
    default: {http: ['https://rpc.testnet.arc.io']},
  },
  blockExplorers: {
    default: {name: 'Arcscan', url: 'https://testnet.arcscan.app'},
  },
});

export const arcMainnet = defineChain({
  id: ARC_MAINNET_ID,
  name: 'Arc',
  nativeCurrency: {name: 'USD Coin', symbol: 'USDC', decimals: 18},
  rpcUrls: {
    default: {http: ['https://rpc.mainnet.arc.io']},
  },
  blockExplorers: {
    default: {name: 'Arcscan', url: 'https://arcscan.app'},
  },
});

export const GAS_LIMITS = {
  createToken: 3_500_000n,
  atomicLaunch: 4_500_000n,
  atomicLaunchBuyLeg: 350_000n,
  curveBuy: 800_000n,
} as const;

/** How often to poll for tx receipts (Arc blocks are fast; default 100ms not 4s). */
export function receiptPollMs(): number {
  const n = Number(process.env.BUNDLER_RECEIPT_POLL_MS ?? 100);
  return Number.isFinite(n) && n >= 50 ? n : 100;
}

export function blockWaitPollMs(): number {
  const n = Number(process.env.BUNDLER_BLOCK_POLL_MS ?? 50);
  return Number.isFinite(n) && n >= 25 ? n : 50;
}

/** Estimated ms per block on Arc — used when BUNDLER_BUNDLE_TIMING=time (default). */
export function blockTimeMs(): number {
  const n = Number(process.env.BUNDLER_BLOCK_TIME_MS ?? 250);
  return Number.isFinite(n) && n >= 50 ? n : 250;
}

export type BundleTiming = 'time' | 'block';

export function bundleTiming(): BundleTiming {
  const v = (process.env.BUNDLER_BUNDLE_TIMING ?? 'time').toLowerCase();
  return v === 'block' ? 'block' : 'time';
}

export function bundleDelayMs(blocksAfterCreate: number): number {
  return blocksAfterCreate * blockTimeMs();
}

function normalizePrivateKey(raw: string): `0x${string}` | null {
  const s = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return `0x${s}` as `0x${string}`;
  return null;
}

export function loadWalletKeyPool(): `0x${string}`[] {
  const raw = process.env.BUNDLER_WALLET_KEYS ?? '';
  return raw
    .split(/[,\n]/)
    .map((part) => normalizePrivateKey(part))
    .filter((k): k is `0x${string}` => k != null);
}

export function chainForId(chainId: number): Chain {
  if (chainId === ARC_MAINNET_ID) return arcMainnet;
  if (chainId === ARC_TESTNET_ID) return arcTestnet;
  throw new Error(`Unsupported CHAIN_ID ${chainId}. Use ${ARC_MAINNET_ID} (mainnet) or ${ARC_TESTNET_ID} (testnet).`);
}

export function defaultRpcForChain(chainId: number): string {
  if (chainId === ARC_MAINNET_ID) return 'https://rpc.mainnet.arc.io';
  if (chainId === ARC_TESTNET_ID) return 'https://rpc.testnet.arc.io';
  throw new Error(`Unsupported CHAIN_ID ${chainId}`);
}

export function loadConfig() {
  ensureDotenv();
  const chainId = Number(process.env.CHAIN_ID ?? ARC_TESTNET_ID);
  const chain = chainForId(chainId);
  const rpcUrl = process.env.ARC_RPC_URL ?? defaultRpcForChain(chainId);
  const factory = process.env.FACTORY_ADDRESS?.trim() || (chainId === ARC_TESTNET_ID ? OKEI_FUN_FACTORY : '');
  const privateKey = normalizePrivateKey(process.env.BOT_PRIVATE_KEY ?? '');
  const apiKey = process.env.BUNDLER_API_KEY ?? '';
  const port = Number(process.env.BUNDLER_PORT ?? 8787);
  const defaultOkeiSite = 'https://okei.fun';
  const okeiSiteUrl = (process.env.OKEI_SITE_URL ?? defaultOkeiSite).replace(/\/$/, '');
  const explorerBase =
    process.env.EXPLORER_URL?.replace(/\/$/, '') ??
    chain.blockExplorers?.default.url ??
    'https://arcscan.app';

  if (!factory || !/^0x[0-9a-fA-F]{40}$/.test(factory)) {
    throw new Error(
      'FACTORY_ADDRESS is required. okei.fun production: 0x975F33Ebcc1514d5834Bf3C477c7A9F9d5Cc4856 (still Arc testnet 5042002). Arc mainnet 5042 has no published factory yet.',
    );
  }
  if (!privateKey) {
    throw new Error('BOT_PRIVATE_KEY is required (0x + 64 hex chars)');
  }

  const atomicLaunch = process.env.ATOMIC_LAUNCH_ADDRESS?.trim();
  const atomicLaunchAddress =
    atomicLaunch && /^0x[0-9a-fA-F]{40}$/.test(atomicLaunch)
      ? (atomicLaunch as `0x${string}`)
      : undefined;

  return {
    rpcUrl,
    chainId,
    chain,
    networkLabel: chainId === ARC_MAINNET_ID ? 'Arc Mainnet' : 'Arc Testnet',
    factory: factory as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    apiKey,
    port,
    okeiSiteUrl,
    explorerBase,
    atomicLaunchAddress,
  };
}
