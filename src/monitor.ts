import {randomUUID} from 'node:crypto';

import {parseAbiItem, parseEventLogs, type Hash, type PublicClient} from 'viem';

import {okeiCurveAbi} from './abis/curve.js';
import {okeiFactoryAbi} from './abis/factory.js';

export type MonitorTxRow = {
  hash: Hash;
  role: 'create' | 'bundle-buy';
  status: 'success' | 'reverted';
  blockNumber: number;
  transactionIndex: number;
  from: `0x${string}`;
};

export type ForeignBuy = {
  txHash: Hash;
  blockNumber: number;
  transactionIndex: number;
  buyer: `0x${string}`;
  to: `0x${string}`;
  usdcIn: string;
  tokensOut: string;
};

export type LaunchMonitorReport = {
  id: string;
  analyzedAt: string;
  curve: `0x${string}`;
  token: `0x${string}`;
  mode: 'same-block' | 'direct' | 'atomic' | 'unknown';
  /** Overall bundle health for operators. */
  verdict: 'ok' | 'warning' | 'failed';
  summary: string;
  checks: {
    sameBlock: boolean;
    createFirstInBlock: boolean;
    allTxsSuccess: boolean;
    noForeignBuysBeforeBundleDone: boolean;
  };
  createTxHash: Hash;
  buyTxHashes: Hash[];
  transactions: MonitorTxRow[];
  foreignBuys: ForeignBuy[];
  blockNumbers: number[];
  explorerLinks: {label: string; url: string}[];
};

export type AnalyzeInput = {
  createTxHash: Hash;
  buyTxHashes?: Hash[];
  mode?: LaunchMonitorReport['mode'];
  symbol?: string;
};

export async function analyzeLaunchBundle(
  publicClient: PublicClient,
  explorerBase: string,
  input: AnalyzeInput,
): Promise<LaunchMonitorReport> {
  const buyTxHashes = input.buyTxHashes ?? [];
  const allHashes = [input.createTxHash, ...buyTxHashes];

  const receipts = await Promise.all(
    allHashes.map((h) => publicClient.getTransactionReceipt({hash: h})),
  );

  const txs = await Promise.all(allHashes.map((h) => publicClient.getTransaction({hash: h})));

  const createReceipt = receipts[0];
  if (!createReceipt) {
    throw new Error(`create tx not found: ${input.createTxHash}`);
  }

  const [created] = parseEventLogs({
    abi: okeiFactoryAbi,
    eventName: 'TokenCreated',
    logs: createReceipt.logs,
  });
  if (!created) {
    throw new Error(`TokenCreated missing in ${input.createTxHash}`);
  }

  const curve = created.args.curve;
  const token = created.args.token;

  const transactions: MonitorTxRow[] = allHashes.map((hash, i) => {
    const r = receipts[i]!;
    const t = txs[i]!;
    return {
      hash,
      role: i === 0 ? 'create' : 'bundle-buy',
      status: r.status === 'success' ? 'success' : 'reverted',
      blockNumber: Number(r.blockNumber),
      transactionIndex: Number(r.transactionIndex),
      from: t.from,
    };
  });

  const blockNumbers = transactions.map((t) => t.blockNumber);
  const sameBlock = blockNumbers.every((b) => b === blockNumbers[0]);
  const createIndex = transactions[0]!.transactionIndex;
  const buyRows = transactions.slice(1);
  const createFirstInBlock =
    buyRows.length === 0 ||
    buyRows.every((t) => t.transactionIndex > createIndex && t.blockNumber === blockNumbers[0]);
  const allTxsSuccess = transactions.every((t) => t.status === 'success');

  const ourHashes = new Set(allHashes.map((h) => h.toLowerCase()));
  const minBlock = Math.min(...blockNumbers);
  const maxBlock = Math.max(...blockNumbers);
  const lastBundleIndex = Math.max(
    createIndex,
    ...buyRows.map((t) => t.transactionIndex),
  );
  const firstBuyIndex =
    buyRows.length === 0 ? lastBundleIndex + 1 : Math.min(...buyRows.map((t) => t.transactionIndex));

  const logs = await publicClient.getLogs({
    address: curve,
    event: parseAbiItem(
      'event Buy(address indexed buyer, address indexed to, uint256 usdcIn, uint256 fee, uint256 tokensOut, uint256 usdcReserve, uint256 tokenReserve)',
    ),
    fromBlock: BigInt(minBlock),
    toBlock: BigInt(maxBlock),
  });

  const foreignBuys: ForeignBuy[] = [];
  for (const log of logs) {
    const txHash = log.transactionHash!;
    if (ourHashes.has(txHash.toLowerCase())) continue;

    const parsed = parseEventLogs({
      abi: okeiCurveAbi,
      eventName: 'Buy',
      logs: [log],
    })[0];
    if (!parsed) continue;

    const blockNumber = Number(log.blockNumber);
    const txIndex = Number(log.transactionIndex ?? 0);

    if (!isForeignBuyInBundleWindow({
      blockNumber,
      txIndex,
      minBlock,
      maxBlock,
      createIndex,
      firstBuyIndex,
      lastBundleIndex,
      sameBlock,
    })) {
      continue;
    }

    foreignBuys.push({
      txHash,
      blockNumber,
      transactionIndex: txIndex,
      buyer: parsed.args.buyer,
      to: parsed.args.to,
      usdcIn: parsed.args.usdcIn.toString(),
      tokensOut: parsed.args.tokensOut.toString(),
    });
  }

  foreignBuys.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber - b.blockNumber
      : a.transactionIndex - b.transactionIndex,
  );

  const noForeignBuysBeforeBundleDone = foreignBuys.length === 0;

  let verdict: LaunchMonitorReport['verdict'] = 'ok';
  if (!allTxsSuccess) verdict = 'failed';
  else if (!sameBlock || !createFirstInBlock || !noForeignBuysBeforeBundleDone) verdict = 'warning';

  const parts: string[] = [];
  parts.push(sameBlock ? 'same block' : `split blocks ${blockNumbers.join(',')}`);
  parts.push(createFirstInBlock ? 'create ordered first' : 'create NOT before all buys');
  parts.push(
    noForeignBuysBeforeBundleDone
      ? 'no sniper buys between create and bundle'
      : `${foreignBuys.length} foreign buy(s) in window`,
  );
  if (!allTxsSuccess) parts.push('reverted tx in bundle');

  const id =
    input.symbol?.replace(/[^a-zA-Z0-9]/g, '') ||
    randomUUID().slice(0, 8);
  const stamp = Date.now();

  const explorerLinks = [
    {label: 'create', url: `${explorerBase}/tx/${input.createTxHash}`},
    ...buyTxHashes.map((h, i) => ({label: `buy-${i + 1}`, url: `${explorerBase}/tx/${h}`})),
    {label: 'curve', url: `${explorerBase}/address/${curve}`},
  ];

  return {
    id: `${stamp}-${id}`,
    analyzedAt: new Date().toISOString(),
    curve,
    token,
    mode: input.mode ?? (buyTxHashes.length ? 'same-block' : 'unknown'),
    verdict,
    summary: parts.join('; '),
    checks: {
      sameBlock,
      createFirstInBlock,
      allTxsSuccess,
      noForeignBuysBeforeBundleDone,
    },
    createTxHash: input.createTxHash,
    buyTxHashes,
    transactions,
    foreignBuys,
    blockNumbers,
    explorerLinks,
  };
}

/** Foreign buys that landed after create and before the last bundle tx (per block rules). */
export function isForeignBuyInBundleWindow(args: {
  blockNumber: number;
  txIndex: number;
  minBlock: number;
  maxBlock: number;
  createIndex: number;
  firstBuyIndex: number;
  lastBundleIndex: number;
  sameBlock: boolean;
}): boolean {
  const {
    blockNumber,
    txIndex,
    minBlock,
    maxBlock,
    createIndex,
    firstBuyIndex,
    lastBundleIndex,
    sameBlock,
  } = args;

  if (blockNumber < minBlock || blockNumber > maxBlock) return false;
  if (blockNumber > minBlock && blockNumber < maxBlock) return true;
  if (sameBlock) {
    return txIndex > createIndex && txIndex <= lastBundleIndex;
  }
  if (blockNumber === minBlock) return txIndex > createIndex;
  if (blockNumber === maxBlock && firstBuyIndex <= lastBundleIndex) {
    return txIndex < firstBuyIndex;
  }
  return false;
}

export function printMonitorReport(report: LaunchMonitorReport, explorerBase: string) {
  const icon = report.verdict === 'ok' ? 'OK' : report.verdict === 'warning' ? 'WARN' : 'FAIL';
  console.log(`[monitor] ${icon} ${report.summary}`);
  console.log(`[monitor] curve ${report.curve} token ${report.token}`);
  console.log(`[monitor] saved id ${report.id}`);
  for (const row of report.transactions) {
    console.log(
      `[monitor]   ${row.role} idx=${row.transactionIndex} block=${row.blockNumber} ${row.status} ${row.from}`,
    );
    console.log(`[monitor]     ${explorerBase}/tx/${row.hash}`);
  }
  for (const fb of report.foreignBuys) {
    console.log(
      `[monitor]   SNIPER? buy idx=${fb.transactionIndex} block=${fb.blockNumber} buyer=${fb.buyer}`,
    );
    console.log(`[monitor]     ${explorerBase}/tx/${fb.txHash}`);
  }
}
