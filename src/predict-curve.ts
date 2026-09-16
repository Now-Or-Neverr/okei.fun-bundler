import {getContractAddress, type PublicClient} from 'viem';

/** Next curve + token from OkeiFactory.createToken (two CREATEs: clone, then OkeiToken). */
export async function predictCreateTokenAddresses(
  publicClient: PublicClient,
  factory: `0x${string}`,
): Promise<{curve: `0x${string}`; token: `0x${string}`; factoryNonce: bigint}> {
  const factoryNonce = await publicClient.getTransactionCount({
    address: factory,
    blockTag: 'pending',
  });
  const curve = getContractAddress({
    from: factory,
    nonce: BigInt(factoryNonce),
  });
  const token = getContractAddress({
    from: factory,
    nonce: BigInt(factoryNonce + 1),
  });
  return {curve, token, factoryNonce: BigInt(factoryNonce)};
}
