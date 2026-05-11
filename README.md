# Hiper Prices Extension

Manifest V3 browser extension with two surfaces:

- **Product pages** — overlay shows current price, a price-history
  chart with 1w / 1m / 3m / all range toggles, cross-retailer matches
  (with thumbnails and thumbs-up/down votes), and a collapsible
  per-100g nutrition block. Each match has a "+ carrinho" button that
  adds the equivalent product to the peer retailer's cart in the
  background, using the user's existing session cookies for that
  retailer (no login required by the extension itself; user logs in
  to each retailer normally if they want a persistent cart).
- **Basket / cart pages** — a floating panel scrapes the line items
  from the page DOM and shows per-peer-retailer totals, toggles
  (include similar / exclude items with no match), and a one-click
  "fill peer's cart" button per peer retailer.

## Install

Sideload-ready `.zip` packages are published on the
[Releases page](https://github.com/miguelglopes/hiper-prices/releases) —
download, unzip, and load unpacked. For development from source, see below.

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select the cloned directory.

The content script currently supports:

- `www.continente.pt`
- `www.auchan.pt`
- `www.pingodoce.pt`

By default it reads from `https://hiper-prices.mglopes.com`. For local
development, set `apiBase` in extension storage to `http://127.0.0.1:5000`.

## Architecture

```
manifest.json            # Manifest V3 declaration
src/content.js           # Injected on retailer pages — UI, basket scrape, vote calls
src/content.css          # Panel styles
src/background.js        # Service worker — cross-origin cart-add
```

**Permissions** (from `manifest.json`): only `storage` (for the
`apiBase` override and the per-voter UUID) plus host permissions for
the three retailer origins and the API origin. No `tabs`, no
`webRequest`, no `<all_urls>`.

**Cart-add via the service worker.** The content script posts an
`hp:addToCart` message to `background.js`, which makes a cross-origin
`POST` to the retailer's `Cart-AddProduct` endpoint with
`credentials: "include"`. Because the user is already authenticated
to the retailer in their browser, those cookies are attached
automatically — the extension itself never sees or stores
credentials.

Per-retailer quirks (`background.js::RETAILERS`):
- **Auchan** requires a CSRF token — the worker fetches the product
  page first, scrapes `name="csrf_token"`, then includes it in the
  cart POST.
- **Continente** and **Pingo Doce** accept the cart POST without a
  CSRF token.

**Bulk cart-fill.** The basket-page panel uses a long-running
`chrome.runtime.connect` port (`hp:bulkAddToCart`) so the worker can
stream `progress` / `result` / `done` events back to the UI as it
fills one peer's cart with N items serially. A single `sendMessage`
would risk the worker timing out mid-batch.

**Failure modes the UI surfaces:** `csrf_failed`, `postal_code`
(Pingo Doce store-zone gate), `remote_error`, `http`, `network`. The
"+ carrinho" button reflects each state via a transient label.

**Voter identity.** A UUID is minted on first vote and persisted in
`chrome.storage.local`. It rides on every API call as the
`X-Voter-Id` header — the API uses it to surface the caller's own
vote and to enforce one-vote-per-pair without touching cookies (the
extension runs cross-origin and can't share the web UI's cookie).

## Publishing

Source lives in the private `hiper-scraper` monorepo (`extension/`
subtree). The public mirror at
[`miguelglopes/hiper-prices`](https://github.com/miguelglopes/hiper-prices)
is updated via `git subtree split`, and Releases on that public repo
are where the sideload `.zip` is published. The backend stays private.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal, hobby,
research, and non-profit use. Commercial use requires a separate
license.
