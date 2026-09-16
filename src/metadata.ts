export type LaunchLinks = {
  x?: string;
  telegram?: string;
  discord?: string;
  website?: string;
};

export type LaunchMetadata = {
  description?: string;
  image?: string;
  links?: LaunchLinks;
};

export type MetadataDraft = {
  description?: string;
  image?: string;
  links?: LaunchLinks;
};

function cleanLinks(links: LaunchLinks): LaunchLinks | undefined {
  const out: LaunchLinks = {};
  for (const key of Object.keys(links) as (keyof LaunchLinks)[]) {
    const value = links[key]?.trim();
    if (value && /^https?:\/\//i.test(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function isSafeImageUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  return (
    value.startsWith('https://') || value.startsWith('ipfs://') || value.startsWith('data:image/')
  );
}

/** Same encoding as okei.fun `web/src/lib/metadata.ts`. */
export function encodeMetadata(draft: MetadataDraft): string {
  const doc: LaunchMetadata = {};
  const description = draft.description?.trim() ?? '';
  const image = draft.image?.trim() ?? '';

  if (description) doc.description = description;
  if (image && isSafeImageUrl(image)) doc.image = image;
  const links = draft.links ? cleanLinks(draft.links) : undefined;
  if (links) doc.links = links;

  if (Object.keys(doc).length === 0) return '';
  return `data:application/json,${encodeURIComponent(JSON.stringify(doc))}`;
}

export const uriByteLength = (uri: string) => new TextEncoder().encode(uri).length;

export const gasForMetadata = (uri: string) => BigInt(uriByteLength(uri) * 900);

/** Parse a `data:application/json,…` metadata URI (same rules as okei.fun). */
export function parseDataUri(uri: string): LaunchMetadata | null {
  if (!uri.startsWith('data:')) return null;
  try {
    const comma = uri.indexOf(',');
    if (comma === -1) return null;
    const header = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    const json = header.includes(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
    const parsed = JSON.parse(json) as LaunchMetadata;
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
}
