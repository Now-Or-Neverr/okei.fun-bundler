# Launch JSON (okei.fun `/create` parity)

Each file maps to the [okei.fun](https://okei.fun/) launch form.

| JSON field | Form |
|------------|------|
| `name` | Name |
| `symbol` | Ticker (1–11 alphanumeric) |
| `initialBuyUsdc` | Opening buy (USDC) |
| `venue` | Graduates to: `okeiswap` (default) or `uniswap` when available |
| `metadata.description` | Lore |
| `logoFile` | Local logo path (PNG/JPEG/WebP/GIF, max 2MB) — bot pins to IPFS before launch (same as okei **Upload to IPFS**) |
| `metadata.image` | Or paste `ipfs://…` / `https://` instead of `logoFile` |
| `metadata.links` | X, Telegram, Discord, Website |
| `metadataURI` | Optional — “Use my own metadata document” (overrides `metadata`) |

Bundler-only (not on the website form):

| Field | Meaning |
|-------|---------|
| `walletBuys` | Extra buys from `BUNDLER_WALLET_KEYS` |
| `slippageBps` | Min-out tolerance in bps (default **1500** = 15%; okei form default is 3%) |
| `blocksAfterCreate` | Delay multiplier before wallet buys (`× BUNDLER_BLOCK_TIME_MS`) |
| `bundleBuys` | One-tx multi-buy via `ATOMIC_LAUNCH_ADDRESS` |

Run with `npm run dev`, then e.g. `npm run launch:file -- examples/launch.json`.

### Logo shows as ticker initials (e.g. “BDL” for BDLY)

The upload may still be fine. Check:

1. `npm run upload:logo -- examples/logo.png` — prints `image` and `gatewayUrl`; open the URL in a browser.
2. On-chain metadata for your token (`metadataURI` on the token contract) should include an `image` field.

If the gateway URL loads but okei.fun shows initials, the site’s IPFS gateway may be timing out. Relaunch with `BUNDLER_LOGO_IMAGE_HTTPS=1` in `.env` so the token stores a direct `https://…/ipfs/…` image link.
