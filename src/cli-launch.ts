import {createBot} from './bot.js';
import type {LaunchRequest} from './launch.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

async function main() {
  const name = arg('--name') ?? process.env.NAME;
  const symbol = arg('--symbol') ?? process.env.SYMBOL;
  if (!name || !symbol) {
    console.error('Usage: npm run launch -- --name "My Coin" --symbol MCAT [--buy 0.1] [--desc "..."]');
    process.exit(1);
  }

  const req: LaunchRequest = {
    name,
    symbol,
    initialBuyUsdc: arg('--buy') ?? process.env.INITIAL_BUY ?? '0',
    metadata: {
      description: arg('--desc') ?? '',
      image: arg('--image') ?? '',
    },
    venue: (arg('--venue') as 'okeiswap' | 'uniswap') ?? 'okeiswap',
  };

  const {runOne, logResult} = createBot();
  const result = await runOne(req);
  logResult(req, result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
