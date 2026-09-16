import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {createBot} from './bot.js';
import type {LaunchRequest} from './launch.js';

async function main() {
  const path = process.argv[2] ?? 'examples/bundle-queue.json';
  const full = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(full, 'utf8')) as {launches: LaunchRequest[]};
  if (!raw.launches?.length) {
    console.error('Manifest must contain launches[]');
    process.exit(1);
  }

  const gapMs = Number(process.env.BUNDLE_GAP_MS ?? '3000');
  const {runOne, logResult} = createBot();

  for (const req of raw.launches) {
    const result = await runOne(req);
    logResult(req, result);
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
