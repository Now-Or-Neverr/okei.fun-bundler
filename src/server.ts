import {createServer} from 'node:http';

import {loadConfig, loadWalletKeyPool} from './config.js';
import {createLaunchClients} from './launch.js';
import {createBot} from './bot.js';
import {analyzeLaunchBundle} from './monitor.js';
import {getLaunchReport, listLaunchReports, saveLaunchReport} from './monitor-store.js';
import type {LaunchJob} from './queue.js';
import type {LaunchRequest} from './launch.js';
import {validateLaunchRequest} from './launch.js';

function serializeJob(job: LaunchJob) {
  return {
    ...job,
    result: job.result
      ? {...job.result, tokensOut: job.result.tokensOut.toString()}
      : undefined,
  };
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}

function authOk(req: import('node:http').IncomingMessage, apiKey: string): boolean {
  if (!apiKey) return true;
  const h = req.headers['authorization'];
  if (h === `Bearer ${apiKey}`) return true;
  const x = req.headers['x-bundler-key'];
  return x === apiKey;
}

async function main() {
  const bot = createBot();
  const {cfg, queue, runOne, processQueue, logResult} = bot;

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      res.writeHead(400);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, {
        ok: true,
        network: cfg.networkLabel,
        chainId: cfg.chainId,
        rpcUrl: cfg.rpcUrl,
        factory: cfg.factory,
        atomicLaunch: cfg.atomicLaunchAddress ?? null,
        walletPoolSize: loadWalletKeyPool().length,
        queueDepth: queue.list().filter((j) => j.status === 'queued').length,
        worker: queue.runningWorker,
      });
      return;
    }

    if (!authOk(req, cfg.apiKey)) {
      json(res, 401, {ok: false, error: 'unauthorized'});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jobs') {
      json(res, 200, {ok: true, jobs: queue.list().map(serializeJob)});
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
      const id = url.pathname.slice('/jobs/'.length);
      const job = queue.get(id);
      if (!job) {
        json(res, 404, {ok: false, error: 'not found'});
        return;
      }
      json(res, 200, {ok: true, job: serializeJob(job)});
      return;
    }

    if (req.method === 'GET' && url.pathname === '/monitor/reports') {
      const limit = Number(url.searchParams.get('limit') ?? '30');
      const reports = await listLaunchReports(limit);
      json(res, 200, {ok: true, reports});
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/monitor/reports/')) {
      const id = url.pathname.slice('/monitor/reports/'.length);
      const report = await getLaunchReport(id);
      if (!report) {
        json(res, 404, {ok: false, error: 'not found'});
        return;
      }
      json(res, 200, {ok: true, report});
      return;
    }

    if (req.method === 'POST' && url.pathname === '/monitor/analyze') {
      let body: {createTxHash?: string; buyTxHashes?: string[]; symbol?: string};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, {ok: false, error: 'invalid json'});
        return;
      }
      if (!body.createTxHash?.startsWith('0x')) {
        json(res, 400, {ok: false, error: 'createTxHash required'});
        return;
      }
      try {
        const cfgFull = loadConfig();
        const clients = createLaunchClients(
          cfgFull.rpcUrl,
          cfgFull.privateKey,
          cfgFull.factory,
          cfgFull.chain,
        );
        const buyTxHashes = (body.buyTxHashes ?? []) as `0x${string}`[];
        const report = await analyzeLaunchBundle(clients.publicClient, cfgFull.explorerBase, {
          createTxHash: body.createTxHash as `0x${string}`,
          buyTxHashes,
          symbol: body.symbol,
          mode: buyTxHashes.length ? 'same-block' : 'direct',
        });
        await saveLaunchReport(report);
        json(res, 200, {ok: true, report});
      } catch (e) {
        json(res, 502, {ok: false, error: e instanceof Error ? e.message : String(e)});
      }
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/launch' || url.pathname === '/bundle')) {
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, {ok: false, error: 'invalid json'});
        return;
      }

      const requests: LaunchRequest[] =
        url.pathname === '/bundle'
          ? (body as {launches?: LaunchRequest[]}).launches ?? []
          : [body as LaunchRequest];

      if (!Array.isArray(requests) || requests.length === 0) {
        json(res, 400, {ok: false, error: 'launches array required for /bundle'});
        return;
      }

      for (const r of requests) {
        const err = validateLaunchRequest(r);
        if (err) {
          json(res, 400, {ok: false, error: err});
          return;
        }
      }

      const sync = url.searchParams.get('sync') === '1';
      const gapMs = Number(url.searchParams.get('gapMs') ?? '2000');

      if (sync && requests.length === 1) {
        try {
          const result = await runOne(requests[0]!);
          logResult(requests[0]!, result);
          json(res, 200, {
            ok: true,
            result: {
              ...result,
              tokensOut: result.tokensOut.toString(),
              okeiUrl: `${cfg.okeiSiteUrl}/token/${result.curve}`,
              buyTxHashes: result.buyTxHashes,
              sameBlock: result.sameBlock,
              createFirstInBlock: result.createFirstInBlock,
              blockNumbers: result.blockNumbers,
              monitorId: result.monitorId,
              monitorVerdict: result.monitorVerdict,
              blocksAfterCreate: result.blocksAfterCreate,
              createBlockNumber: result.createBlockNumber,
              bundleBlockNumber: result.bundleBlockNumber,
              hitBundleBlock: result.hitBundleBlock,
              bundleTiming: result.bundleTiming,
              bundleDelayMs: result.bundleDelayMs,
            },
          });
        } catch (e) {
          json(res, 502, {ok: false, error: e instanceof Error ? e.message : String(e)});
        }
        return;
      }

      if (sync && requests.length > 1) {
        const results = [];
        for (const r of requests) {
          try {
            const result = await runOne(r);
            logResult(r, result);
            results.push({
              ...result,
              tokensOut: result.tokensOut.toString(),
              okeiUrl: `${cfg.okeiSiteUrl}/token/${result.curve}`,
            });
          } catch (e) {
            json(res, 502, {
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              partial: results,
            });
            return;
          }
          if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        }
        json(res, 200, {ok: true, results});
        return;
      }

      const jobs = queue.enqueueMany(requests);
      void processQueue(gapMs).catch((e) => console.error('[bundler] worker error', e));
      json(res, 202, {ok: true, jobs: jobs.map((j) => ({id: j.id, status: j.status}))});
      return;
    }

    json(res, 404, {ok: false, error: 'not found'});
  });

  server.listen(cfg.port, () => {
    console.log(`[bundler] listening on http://127.0.0.1:${cfg.port}`);
    console.log(`[bundler] ${cfg.networkLabel} (${cfg.chainId}) factory ${cfg.factory}`);
    console.log(`[bundler] RPC ${cfg.rpcUrl}`);
    console.log('[bundler] POST /launch ?sync=1  |  GET /monitor/reports  |  POST /monitor/analyze');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
