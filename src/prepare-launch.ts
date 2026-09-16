import type {LaunchRequest} from './launch.js';
import {encodeMetadata, parseDataUri} from './metadata.js';
import {ipfsToGatewayUrl, uploadLogoFile} from './upload-logo.js';

/** Upload local logo (if any) and set `metadataURI` like okei.fun/create. */
export async function prepareLaunchRequest(req: LaunchRequest): Promise<LaunchRequest> {
  if (req.metadataURI?.trim()) {
    return req;
  }

  const draft = {...(req.metadata ?? {})};
  if (req.logoFile?.trim()) {
    if (draft.image?.trim()) {
      throw new Error('Use logoFile or metadata.image, not both');
    }
    draft.image = await uploadLogoFile(req.logoFile.trim());
    const preview =
      draft.image.startsWith('ipfs://') ? ipfsToGatewayUrl(draft.image) : draft.image;
    console.log(`[bundler] logo pinned → ${draft.image} (preview: ${preview})`);
  }

  const metadataURI = encodeMetadata(draft);
  if (req.logoFile?.trim()) {
    const doc = parseDataUri(metadataURI);
    if (!doc?.image?.trim()) {
      throw new Error('logoFile was set but encoded metadata has no image field');
    }
  }
  return {...req, metadataURI};
}
