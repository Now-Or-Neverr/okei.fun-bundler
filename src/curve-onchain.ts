import type {PublicClient} from 'viem';

import {okeiCurveAbi} from './abis/curve.js';
import type {CurveState} from './curve.js';

export async function readCurveState(
  publicClient: PublicClient,
  curve: `0x${string}`,
): Promise<CurveState> {
  const [usdcReserve, tokenReserve, virtualUsdc, totalSupply, raiseTarget, tradeFeeBps, graduated] =
    await Promise.all([
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'usdcReserve'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'tokenReserve'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'virtualUsdc'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'totalSupply'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'raiseTarget'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'tradeFeeBps'}),
      publicClient.readContract({address: curve, abi: okeiCurveAbi, functionName: 'graduated'}),
    ]);

  return {
    usdcReserve,
    tokenReserve,
    virtualUsdc,
    totalSupply,
    raiseTarget,
    tradeFeeBps: BigInt(tradeFeeBps),
    graduated,
  };
}
