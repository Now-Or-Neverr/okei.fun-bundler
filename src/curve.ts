import type {Address} from 'viem';

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export type CurveState = {
  usdcReserve: bigint;
  tokenReserve: bigint;
  virtualUsdc: bigint;
  totalSupply: bigint;
  raiseTarget: bigint;
  tradeFeeBps: bigint;
  graduated: boolean;
};

function tokensOutForUsdcIn(x: bigint, y: bigint, usdcIn: bigint): bigint {
  if (usdcIn <= 0n) return 0n;
  return y - ceilDiv(x * y, x + usdcIn);
}

function feeOn(amount: bigint, feeBps: bigint) {
  return (amount * feeBps) / BPS;
}

function grossForNet(net: bigint, feeBps: bigint) {
  return ceilDiv(net * BPS, BPS - feeBps);
}

const usdcRaised = (c: CurveState) => c.usdcReserve - c.virtualUsdc;

export function quoteBuy(c: CurveState, grossIn: bigint) {
  if (c.graduated || grossIn <= 0n) {
    return {tokensOut: 0n, refund: grossIn > 0n ? grossIn : 0n, netIn: 0n};
  }
  const headroom = c.raiseTarget - usdcRaised(c);
  let fee = feeOn(grossIn, c.tradeFeeBps);
  let netIn = grossIn - fee;
  let refund = 0n;

  if (netIn > headroom) {
    netIn = headroom;
    const grossNeeded = grossForNet(headroom, c.tradeFeeBps);
    refund = grossIn - grossNeeded;
    fee = grossNeeded - netIn;
  }
  return {
    tokensOut: tokensOutForUsdcIn(c.usdcReserve, c.tokenReserve, netIn),
    refund,
    netIn,
  };
}

/** Post-buy curve state — mirrors on-chain reserve updates after `buy`. */
export function curveAfterBuy(c: CurveState, grossIn: bigint): CurveState {
  const q = quoteBuy(c, grossIn);
  if (q.tokensOut === 0n) return c;
  const usdcReserve = c.usdcReserve + q.netIn;
  const tokenReserve = c.tokenReserve - q.tokensOut;
  const graduated = usdcReserve - c.virtualUsdc >= c.raiseTarget;
  return {...c, usdcReserve, tokenReserve, graduated};
}

/** Default min-out tolerance (15%). Parallel wallet buys often fill out of quote order. */
export const DEFAULT_SLIPPAGE_BPS = 1500;

export const applySlippage = (amount: bigint, slippageBps: number) =>
  (amount * BigInt(10_000 - slippageBps)) / BPS;

/** Synthetic opening curve — mirrors okei CreateLaunchForm preview. */
export function openingCurveFromParams(
  params: readonly [bigint, bigint, bigint, number, number],
): CurveState {
  const [virtualUsdc, totalSupply, raiseTarget, tradeFeeBps] = params;
  return {
    usdcReserve: virtualUsdc,
    tokenReserve: totalSupply,
    virtualUsdc,
    totalSupply,
    raiseTarget,
    tradeFeeBps: BigInt(tradeFeeBps),
    graduated: false,
  };
}

export type {Address};
