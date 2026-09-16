import {createPublicClient, createWalletClient, http} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

import {okeiAtomicLaunchAbi} from './abis/atomic-launch.js';
import {loadConfig} from './config.js';

async function main() {
  const cfg = loadConfig();
  const account = privateKeyToAccount(cfg.privateKey);
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({chain: cfg.chain, transport});
  const walletClient = createWalletClient({chain: cfg.chain, transport, account});

  console.log(`[deploy] factory ${cfg.factory}`);
  console.log(`[deploy] owner will be ${account.address}`);

  const hash = await walletClient.deployContract({
    chain: cfg.chain,
    account,
    abi: okeiAtomicLaunchAbi,
    bytecode: await loadBytecode(),
    args: [cfg.factory],
    gas: 2_500_000n,
  });

  const receipt = await publicClient.waitForTransactionReceipt({hash});
  if (!receipt.contractAddress) {
    throw new Error(`no contract address in ${hash}`);
  }

  console.log(`[deploy] OkeiAtomicLaunch ${receipt.contractAddress}`);
  console.log(`[deploy] tx ${cfg.explorerBase}/tx/${hash}`);
  console.log(`[deploy] add to .env: ATOMIC_LAUNCH_ADDRESS=${receipt.contractAddress}`);
}

async function loadBytecode(): Promise<`0x${string}`> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const artifact = path.join(
    process.cwd(),
    'out',
    'OkeiAtomicLaunch.sol',
    'OkeiAtomicLaunch.json',
  );
  try {
    const raw = JSON.parse(await fs.readFile(artifact, 'utf8')) as {bytecode?: {object?: string}};
    const hex = raw.bytecode?.object;
    if (!hex || !hex.startsWith('0x')) {
      throw new Error('missing bytecode.object');
    }
    return hex as `0x${string}`;
  } catch {
    throw new Error(
      'Compile first: cd bundler && forge build — then re-run npm run deploy:atomic',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
