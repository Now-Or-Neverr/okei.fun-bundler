import path from 'node:path';

import {config as loadDotenv} from 'dotenv';

import {ipfsToGatewayUrl, uploadLogoFile} from './upload-logo.js';

async function main() {
  loadDotenv();
  const fileArg = process.argv[2] ?? 'examples/logo.png';
  const resolved = path.resolve(process.cwd(), fileArg);
  const image = await uploadLogoFile(resolved);
  const gateway = image.startsWith('ipfs://') ? ipfsToGatewayUrl(image) : image;
  console.log(JSON.stringify({ok: true, image, gatewayUrl: gateway}, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
