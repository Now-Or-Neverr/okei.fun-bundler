# Okei launch bundler

Bot that launches tokens through **`OkeiFactory.createToken`** — the same path as [okei.fun](https://okei.fun/) `/create`.

**Production site** ([okei.fun](https://okei.fun/docs)) is still **Arc Testnet** (`CHAIN_ID=5042002`) with the stock **$6,000 / $14,000** curve and factory `0x975F33Ebcc1514d5834Bf3C477c7A9F9d5Cc4856`. Arc mainnet (`5042`) has no published okei factory yet — tokens sent there will not show on the site.

The cheap faucet factory (`0x05b6…a412`, $6 / $24) is [testnet.okei.fun](https://testnet.okei.fun/) only.

## 1. Configure `.env`

```bash
cd bundler
cp .env.example .env
```

| Variable | okei.fun production |
|----------|---------------------|
| `CHAIN_ID` | `5042002` |
| `ARC_RPC_URL` | `https://rpc.testnet.arc.io` |
| `EXPLORER_URL` | `https://testnet.arcscan.app` |
| `FACTORY_ADDRESS` | `0x975F33Ebcc1514d5834Bf3C477c7A9F9d5Cc4856` |
| `OKEI_SITE_URL` | `https://okei.fun` |
| `BOT_PRIVATE_KEY` | Wallet with USDC (`creationFee` is **1 USDC** plus `initialBuyUsdc` plus gas) |

When okei publishes a chain-`5042` factory, switch using the commented block in `.env.example`.

## 2. Point a local okei.fun checkout at the same factory

In `okei.fun-master/web/.env.local` (only if you run the site yourself):

```env
NEXT_PUBLIC_CHAIN_ID=5042002
NEXT_PUBLIC_FACTORY_ADDRESS=0x975F33Ebcc1514d5834Bf3C477c7A9F9d5Cc4856
NEXT_PUBLIC_SITE_URL=https://okei.fun
```

Web, indexer, and bundler must share the **same factory address**.

## 3. Wallet

Add Arc Testnet in MetaMask (this is what [okei.fun](https://okei.fun/) uses today):

- Chain ID: **5042002**
- RPC: `https://rpc.testnet.arc.io`
- Currency: **USDC**, 18 decimals
- Explorer: `https://testnet.arcscan.app`

Fund the bot address with enough native USDC for `1 + initialBuy` per launch, plus each `walletBuys` leg from `BUNDLER_WALLET_KEYS`.

## 4. Run the bundler

```bash
npm install
npm run dev
```

Check network:

```bash
curl http://127.0.0.1:8787/health
```

Expect `"network":"Arc Mainnet","chainId":5042`.

## 5. Send a test launch

**HTTP (sync, waits for receipt):**

```bash
curl -X POST "http://127.0.0.1:8787/launch?sync=1" ^
  -H "content-type: application/json" ^
  -d "{\"name\":\"Mainnet Bundler Test\",\"symbol\":\"MBTEST\",\"initialBuyUsdc\":\"0.1\",\"metadata\":{\"description\":\"mainnet smoke test\"}}"
```

**CLI:**

```bash
npm run launch -- --name "Mainnet Bundler Test" --symbol MBTEST --buy 0.1
```

Response / logs include:

- `curve` / `token` addresses
- `okeiUrl` → open `/token/<curve>` on your okei site
- explorer tx link

## 6. Confirm on okei

1. Wait for the indexer to ingest `TokenCreated` (seconds to minutes depending on sync).
2. Open the logged **okeiUrl** or find the token on the home grid.
3. On Arcscan, verify the launch tx and curve contract.

## Atomic launch (create + dev buy + N buys, one transaction)

No okei.fun contract changes. The bundler ships **`OkeiAtomicLaunch`**: one on-chain tx runs `OkeiFactory.createToken` then `N` extra `curve.buy` calls. Snipers cannot insert buys between those steps.

### Trade-off (no factory fork)

`createToken` must be invoked by a contract to batch calls, so **`OkeiToken.creator` on chain is the atomic launcher address**, not your bot EOA. Dev-buy tokens and USDC refunds are sent to **`beneficiary`** (defaults to `BOT_PRIVATE_KEY` address). Extra legs can use different `recipient` wallets.

### Deploy once

```bash
cd bundler
forge build          # requires Foundry: https://book.getfoundry.sh
npm run deploy:atomic
```

Set `ATOMIC_LAUNCH_ADDRESS` in `.env`. The deployer (`BOT_PRIVATE_KEY`) becomes the launcher **owner** (only it may call `launch`).

### HTTP example

```bash
curl -X POST "http://127.0.0.1:8787/launch?sync=1" ^
  -H "content-type: application/json" ^
  -d @examples/launch-atomic-one-tx.json
```

Body fields:

| Field | Meaning |
|-------|---------|
| `initialBuyUsdc` | Dev buy inside `createToken` |
| `bundleBuys` | Array of `{ "usdc": "0.05", "recipient": "0x…" }` (recipient optional) |
| `beneficiary` | Optional; receives dev-buy tokens + refunds |

Without `bundleBuys`, the bot still uses a direct **`createToken`** from your EOA (creator = bot wallet, single dev buy only).

### Same block vs one tx

This path is **one transaction** (strongest ordering). It is not a Flashbots-style multi-tx bundle; anything that lands **after** your tx can still snipe.

## Same block, N wallets (each pays separately)

When **N funded wallets** must each attach their own USDC, one transaction is impossible. Use **`walletBuys`** instead of `bundleBuys`:

| | `bundleBuys` | `walletBuys` |
|---|--------------|--------------|
| Payer | One address (atomic launcher) | One key per leg |
| Tx count | 1 | 1 create + N buys |
| Ordering | Fully atomic inside tx | Best-effort **same block** |
| On-chain buyer | Launcher contract | Each wallet’s `msg.sender` on `buy` |

1. Set **`BOT_PRIVATE_KEY`** — dev wallet (`createToken` + dev buy).  
2. Set **`BUNDLER_WALLET_KEYS`** — comma-separated `0x…` keys (index `0`, `1`, … in the JSON).  
3. POST body uses `walletBuys: [{ "keyIndex": 0, "usdc": "0.05" }, …]`.

```bash
curl -X POST "http://127.0.0.1:8787/launch?sync=1" ^
  -H "content-type: application/json" ^
  -d @examples/launch-wallets-same-block.json
```

The bot:

1. Predicts the next curve address from the factory nonce (two CREATEs per launch).  
2. Broadcasts **create**, then immediately broadcasts **N buy** txs from each wallet.  
3. Gives create a **higher** priority fee than buys so miners tend to order create first in the block.  
4. Reports `sameBlock`, `createFirstInBlock`, and `blockNumbers` in the response.

### Delay bundle buys after create

Add **`blocksAfterCreate`** (with `walletBuys`):

| Value | Behavior |
|-------|----------|
| `0` or omit | Create + wallet buys in one burst (same block, best-effort) |
| `1` | Create in block **N**, wallet buys target block **N+1** |
| `2` | Buys target **N+2**, etc. |

**Default (`BUNDLER_BUNDLE_TIMING=time`):** after create **confirms**, wait **`blocksAfterCreate × BUNDLER_BLOCK_TIME_MS`** (default `1 × 250ms`), then send wallet buys. Tune `BUNDLER_BLOCK_TIME_MS` on slow RPC (e.g. `1000` ≈ one block gap). JSON field `blocksAfterCreate` is a **multiplier**, not a chain block height.

**Optional (`BUNDLER_BUNDLE_TIMING=block`):** wait for chain block `createBlock + blocksAfterCreate` (needs fast RPC).

Response includes `bundleDelayMs`, `bundleTiming`, `createBlockNumber`, `hitBundleBlock` (block mode only).

With the HTTP bot running (`npm run dev`):

```bash
npm run launch:delayed
```

See **`examples/README.md`** for JSON fields matching the okei.fun form (`name`, `symbol`, `metadata`, `venue`, `initialBuyUsdc`, …).

**Local logo:** set `"logoFile": "examples/logo.png"` (or your path). The bot pins via Pinata (`PINATA_JWT`) or [okei.fun](https://okei.fun/) `/api/upload` — same flow as the site’s **Upload to IPFS** button.

| npm script | Example file |
|------------|----------------|
| `npm run launch:form` | `examples/launch.json` — dev-only, full form fields |
| `npm run launch:same-block` | `examples/launch-wallets-same-block.json` |
| `npm run launch:delayed` | `examples/launch-wallets-delayed.json` |
| `npm run launch:file -- …` | any manifest |

PowerShell:

```powershell
curl.exe -X POST "http://127.0.0.1:8787/launch?sync=1" -H "content-type: application/json" -d "@examples/launch-wallets-delayed.json"
```

Queue multiple creates: `npm run bundle -- examples/bundle-queue.json`.

**Limits:** This is not a private bundle. Snipers can still land between your txs if ordering fails, or in the next block. Another factory `createToken` between predict and send breaks curve prediction — the run fails fast. For stricter ordering you need a block builder / private RPC bundle on Arc (not in this repo).

## Monitoring same-block launches

Every launch (sync, async job, or CLI) runs an **on-chain post-mortem** and saves JSON under `data/monitor/` (override with `BUNDLER_MONITOR_DIR`).

Checks:

| Check | Meaning |
|-------|---------|
| `sameBlock` | Create + all wallet buys share one block |
| `createFirstInBlock` | Create tx index before every buy tx in that block |
| `noForeignBuysBeforeBundleDone` | No other `Buy` on the curve between create and your last bundle tx |
| `verdict` | `ok` / `warning` / `failed` |

After `POST /launch?sync=1`, the response includes `monitorId` and `monitorVerdict`. Console logs lines prefixed with `[monitor]`.

```bash
# Re-analyze arbitrary txs
npm run monitor -- --create 0x... --buys 0xabc,0xdef

# List saved reports
npm run monitor -- --list

curl http://127.0.0.1:8787/monitor/reports
curl http://127.0.0.1:8787/monitor/reports/<monitorId>
curl -X POST http://127.0.0.1:8787/monitor/analyze -H "content-type: application/json" -d "{\"createTxHash\":\"0x...\",\"buyTxHashes\":[\"0x...\"]}"
```

`warning` usually means split blocks, wrong tx order, or a **foreign buy** (possible sniper) in the bundle window — see `foreignBuys` in the report.

## API summary

| Method | Path |
|--------|------|
| GET | `/health` |
| GET | `/monitor/reports`, `/monitor/reports/:id` |
| POST | `/monitor/analyze` |
| POST | `/launch?sync=1` |
| POST | `/bundle?sync=1` with `{ "launches": [ … ] }` |
| POST | `/launch` / `/bundle` | async job queue |
| GET | `/jobs`, `/jobs/:id` |

Optional header: `Authorization: Bearer <BUNDLER_API_KEY>` if set.

## Switch back to the cheap faucet factory

```env
CHAIN_ID=5042002
ARC_RPC_URL=https://rpc.testnet.arc.io
FACTORY_ADDRESS=0x05b6b26cd29a951a2ca47001ac8fc04ec471a412
EXPLORER_URL=https://testnet.arcscan.app
OKEI_SITE_URL=https://testnet.okei.fun
```

Restart the bot after changing `.env`.
