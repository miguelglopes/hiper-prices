# Hiper Prices Extension

Manifest V3 browser extension that injects Hiper price history and
cross-retailer comparisons into supported supermarket product pages.
On non-product pages it scans visible product links and calls the basket
comparison API without storing basket data server-side.

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `extension/` directory.

The content script currently supports:

- `www.continente.pt`
- `www.auchan.pt`
- `www.pingodoce.pt`

By default it reads from `https://hiper-prices.mglopes.com`. For local
development, set `apiBase` in extension storage to `http://127.0.0.1:5000`.
