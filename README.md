# Hiper Prices Extension

Manifest V3 browser extension that injects Hiper price history and
cross-retailer comparisons into supported supermarket product pages.
Each match shows a "+ carrinho" button that adds the equivalent product
to the peer retailer's cart in the background, using the user's existing
session cookies for that retailer (no login required by the extension
itself; user logs in to each retailer normally if they want a persistent
cart).

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

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for personal, hobby,
research, and non-profit use. Commercial use requires a separate
license.
