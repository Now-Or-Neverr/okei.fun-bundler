import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

import {config as loadDotenv} from 'dotenv';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const DEFAULT_GATEWAY = 'https://gateway.pinata.cloud/ipfs/';

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mime = EXT_MIME[ext];
  if (!mime) {
    throw new Error(`logoFile must be PNG, JPEG, WebP, or GIF (got ${ext || 'unknown'})`);
  }
  return mime;
}

function ipfsGatewayBase(): string {
  const fromEnv = process.env.BUNDLER_IPFS_GATEWAY?.trim();
  if (fromEnv) {
    return fromEnv.endsWith('/') ? fromEnv : `${fromEnv}/`;
  }
  return DEFAULT_GATEWAY;
}

/** `ipfs://CID` → gateway URL browsers can load (for metadata `image` when using HTTPS mode). */
export function ipfsToGatewayUrl(ipfsUri: string, gateway = ipfsGatewayBase()): string {
  const cid = ipfsUri.replace(/^ipfs:\/\//i, '');
  return `${gateway}${cid}`;
}

type PinResult = {cid: string} | {error: string};

async function pinToPinata(file: Blob, fileName: string, jwt: string): Promise<PinResult> {
  const v3 = new FormData();
  v3.append('file', file, fileName);
  v3.append('network', 'public');
  v3.append('name', fileName || 'logo');

  const modern = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: {Authorization: `Bearer ${jwt}`},
    body: v3,
  });

  if (modern.ok) {
    const json = (await modern.json()) as {data?: {cid?: string}};
    if (json.data?.cid) return {cid: json.data.cid};
  }

  const legacy = new FormData();
  legacy.append('file', file, fileName);

  const old = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: {Authorization: `Bearer ${jwt}`},
    body: legacy,
  });

  if (old.ok) {
    const json = (await old.json()) as {IpfsHash?: string};
    if (json.IpfsHash) return {cid: json.IpfsHash};
  }

  return {error: 'Pinata upload failed — check PINATA_JWT or use OKEI_SITE_URL /api/upload'};
}

async function pinViaOkeiUpload(siteUrl: string, file: Blob, fileName: string): Promise<PinResult> {
  const base = siteUrl.replace(/\/$/, '');
  const form = new FormData();
  form.append('file', file, fileName);

  const res = await fetch(`${base}/api/upload`, {method: 'POST', body: form});
  const json = (await res.json().catch(() => ({}))) as {uri?: string; cid?: string; error?: string};

  if (!res.ok || !json.uri) {
    return {
      error:
        json.error ??
        (res.status === 501
          ? 'Okei uploads not configured on that site — set PINATA_JWT in bundler .env'
          : `Okei upload failed (${res.status})`),
    };
  }

  const cid = json.cid ?? json.uri.replace(/^ipfs:\/\//, '');
  return {cid};
}

async function verifyGatewayServesImage(gatewayUrl: string): Promise<void> {
  const res = await fetch(gatewayUrl, {method: 'GET', signal: AbortSignal.timeout(45_000)});
  if (!res.ok) {
    throw new Error(`Logo pinned but gateway returned ${res.status} for ${gatewayUrl}`);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new Error(
      `Logo gateway did not return an image (${type || 'unknown type'}). Try BUNDLER_LOGO_IMAGE_HTTPS=1 or BUNDLER_IPFS_GATEWAY.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 8) {
    throw new Error('Logo gateway returned an empty or truncated file');
  }
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isGif = buf.slice(0, 3).toString() === 'GIF';
  const isWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!isPng && !isJpeg && !isGif && !isWebp) {
    throw new Error('Logo gateway response is not a recognizable image file');
  }
}

/** Pin a local logo file; returns value for on-chain metadata `image` field. */
export async function uploadLogoFile(logoFile: string): Promise<string> {
  loadDotenv();
  const resolved = path.isAbsolute(logoFile) ? logoFile : path.resolve(process.cwd(), logoFile);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`logoFile not found: ${resolved}`);
  }
  if (info.size > MAX_BYTES) {
    throw new Error(`logoFile exceeds 2MB (${info.size} bytes)`);
  }

  const mime = mimeForPath(resolved);
  if (!ALLOWED.has(mime)) {
    throw new Error(`logoFile type not allowed: ${mime}`);
  }

  const buffer = await readFile(resolved);
  const fileName = path.basename(resolved);
  const blob = new Blob([buffer], {type: mime});

  const jwt = process.env.PINATA_JWT?.trim();
  let result: PinResult;

  if (jwt) {
    result = await pinToPinata(blob, fileName, jwt);
  } else {
    const site = (process.env.OKEI_SITE_URL ?? 'https://okei.fun').replace(/\/$/, '');
    result = await pinViaOkeiUpload(site, blob, fileName);
  }

  if ('error' in result) {
    throw new Error(result.error);
  }

  const ipfsUri = `ipfs://${result.cid}`;
  const gatewayUrl = ipfsToGatewayUrl(ipfsUri);
  await verifyGatewayServesImage(gatewayUrl);

  const useHttps = process.env.BUNDLER_LOGO_IMAGE_HTTPS === '1';
  return useHttps ? gatewayUrl : ipfsUri;
}
