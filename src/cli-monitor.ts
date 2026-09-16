import {loadConfig} from './config.js';
import {createLaunchClients} from './launch.js';
import {analyzeLaunchBundle, printMonitorReport} from './monitor.js';
import {getLaunchReport, listLaunchReports, saveLaunchReport} from './monitor-store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const list = process.argv.includes('--list');
  const id = arg('--id');

  if (list) {
    const reports = await listLaunchReports(Number(arg('--limit') ?? '20'));
    for (const r of reports) {
      console.log(`${r.id}  ${r.verdict.toUpperCase()}  ${r.summary}`);
    }
    return;
  }

  if (id) {
    const report = await getLaunchReport(id);
    if (!report) {
      console.error('report not found:', id);
      process.exit(1);
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const create = arg('--create');
  if (!create?.startsWith('0x')) {
    console.error(
      'Usage:\n' +
        '  npm run monitor -- --create 0x... --buys 0x,0x\n' +
        '  npm run monitor -- --list [--limit 20]\n' +
        '  npm run monitor -- --id <report-id>',
    );
    process.exit(1);
  }

  const buysRaw = arg('--buys') ?? '';
  const buyTxHashes = buysRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('0x')) as `0x${string}`[];

  const cfg = loadConfig();
  const clients = createLaunchClients(cfg.rpcUrl, cfg.privateKey, cfg.factory, cfg.chain);
  const report = await analyzeLaunchBundle(clients.publicClient, cfg.explorerBase, {
    createTxHash: create as `0x${string}`,
    buyTxHashes,
    mode: buyTxHashes.length ? 'same-block' : 'direct',
  });
  const path = await saveLaunchReport(report);
  printMonitorReport(report, cfg.explorerBase);
  console.log(`[monitor] file ${path}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
