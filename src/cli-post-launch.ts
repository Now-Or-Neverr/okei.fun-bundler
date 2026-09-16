import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {config as loadDotenv} from 'dotenv';

async function main() {
  loadDotenv();
  const fileArg = process.argv[2] ?? 'examples/launch-wallets-delayed.json';
  const filePath = path.resolve(process.cwd(), fileArg);
  const body = await readFile(filePath, 'utf8');

  const port = Number(process.env.BUNDLER_PORT ?? 8787);
  const url = `http://127.0.0.1:${port}/launch?sync=1`;

  const headers: Record<string, string> = {'content-type': 'application/json'};
  const apiKey = process.env.BUNDLER_API_KEY?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {method: 'POST', headers, body});
  const text = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (!res.ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
