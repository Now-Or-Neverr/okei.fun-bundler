import {loadConfig, loadWalletKeyPool} from './config.js';
import {createLaunchClients, launchToken, type LaunchRequest, type LaunchResult} from './launch.js';
import {analyzeLaunchBundle, printMonitorReport} from './monitor.js';
import {saveLaunchReport} from './monitor-store.js';
import {LaunchQueue} from './queue.js';

export function createBot() {
  const cfg = loadConfig();
  const clients = createLaunchClients(cfg.rpcUrl, cfg.privateKey, cfg.factory, cfg.chain);
  const queue = new LaunchQueue();

  const walletKeyPool = loadWalletKeyPool();

  async function runOne(req: LaunchRequest): Promise<LaunchResult> {
    const result = await launchToken(clients, req, {
      atomicLaunch: cfg.atomicLaunchAddress,
      walletKeyPool,
    });
    await attachMonitor(clients.publicClient, cfg.explorerBase, req, result);
    return result;
  }

  async function attachMonitor(
    publicClient: import('viem').PublicClient,
    explorerBase: string,
    req: LaunchRequest,
    result: LaunchResult,
  ) {
    try {
      const createTxHash = result.createTxHash ?? result.txHash;
      const buyTxHashes = result.buyTxHashes ?? [];
      const report = await analyzeLaunchBundle(publicClient, explorerBase, {
        createTxHash,
        buyTxHashes,
        mode: result.mode ?? 'unknown',
        symbol: req.symbol,
      });
      await saveLaunchReport(report);
      printMonitorReport(report, explorerBase);
      result.monitorId = report.id;
      result.monitorVerdict = report.verdict;
    } catch (e) {
      console.warn('[monitor] analyze failed:', e instanceof Error ? e.message : e);
    }
  }

  async function processQueue(gapMs = 2000) {
    await queue.runWorker(runOne, gapMs);
  }

  function logResult(req: LaunchRequest, result: Awaited<ReturnType<typeof launchToken>>) {
    const sym = req.symbol.toUpperCase();
    console.log(
      `[bundler] ${sym} live — curve ${result.curve} token ${result.token} tx ${result.txHash}`,
    );
    if (result.monitorVerdict) {
      console.log(`[bundler] monitor ${result.monitorVerdict.toUpperCase()} id=${result.monitorId}`);
    }
    if (result.mode === 'same-block') {
      const target =
        result.blocksAfterCreate != null && result.blocksAfterCreate > 0
          ? ` | bundle block ${result.bundleBlockNumber} (+${result.blocksAfterCreate}) ${result.hitBundleBlock ? 'hit' : 'MISSED'}`
          : '';
      console.log(
        `[bundler] same-block: ${result.sameBlock ? 'yes' : 'NO'} | create first: ${result.createFirstInBlock ? 'yes' : 'NO'} | buys ${result.buyTxHashes?.length ?? 0}${target}`,
      );
      for (const h of result.buyTxHashes ?? []) {
        console.log(`[bundler]   buy tx ${cfg.explorerBase}/tx/${h}`);
      }
    }
    if (result.logoGatewayUrl) {
      console.log(`[bundler] logo: ${result.logoGatewayUrl}`);
    }
    console.log(`[bundler] view on okei: ${cfg.okeiSiteUrl}/token/${result.curve}`);
    console.log(`[bundler] explorer: ${cfg.explorerBase}/tx/${result.txHash}`);
  }

  return {cfg, queue, runOne, processQueue, logResult};
}

export type Bot = {
  cfg: ReturnType<typeof loadConfig>;
  queue: LaunchQueue;
  runOne: (req: LaunchRequest) => Promise<import('./launch.js').LaunchResult>;
  processQueue: (gapMs?: number) => Promise<void>;
  logResult: (
    req: LaunchRequest,
    result: import('./launch.js').LaunchResult,
  ) => void;
};
