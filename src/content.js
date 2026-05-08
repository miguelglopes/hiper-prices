const DEFAULT_API_BASE = "https://hiper-prices.mglopes.com";

const RETAILERS = {
  "www.continente.pt": {
    id: "continente",
    skuPattern: /\/produto\/.+-(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".pwc-tile--price-primary",
      ".product-detail .prices",
      ".product-info",
      "main"
    ]
  },
  "www.auchan.pt": {
    id: "auchan",
    skuPattern: /\/pt\/.+\/(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".product-detail .prices",
      ".product-detail .price",
      ".product-detail",
      ".product-wrapper"
    ]
  },
  "www.pingodoce.pt": {
    id: "pingodoce",
    skuPattern: /-(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".product-price",
      ".product-wrapper",
      ".product-detail",
      "main"
    ]
  }
};

function getConfig() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.sync) {
      resolve({ apiBase: DEFAULT_API_BASE });
      return;
    }
    chrome.storage.sync.get({ apiBase: DEFAULT_API_BASE }, resolve);
  });
}

function detectPage() {
  const config = RETAILERS[window.location.hostname];
  if (!config) return null;
  const match = extractSku(window.location.href, config);
  if (!match) return null;
  return { retailer: config.id, sku: match, config };
}

function detectRetailer() {
  const config = RETAILERS[window.location.hostname];
  if (!config) return null;
  return { retailer: config.id, config };
}

function extractSku(url, config) {
  try {
    const parsed = new URL(url, window.location.origin);
    const match = parsed.pathname.match(config.skuPattern);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function scanVisibleSkus(config) {
  const seen = new Set();
  const out = [];
  for (const link of document.querySelectorAll("a[href]")) {
    const sku = extractSku(link.href, config);
    if (!sku || seen.has(sku)) continue;
    const rect = link.getBoundingClientRect();
    const hasLayout = rect.width > 0 && rect.height > 0;
    if (!hasLayout) continue;
    seen.add(sku);
    out.push({ sku, quantity: 1 });
    if (out.length >= 50) break;
  }
  return out;
}

const MIN_ANCHOR_WIDTH = 320;

function findAnchor(config) {
  for (const selector of config.anchors) {
    const node = document.querySelector(selector);
    if (!node) continue;
    let walker = node;
    while (walker && walker !== document.body) {
      if (walker.getBoundingClientRect().width >= MIN_ANCHOR_WIDTH) return walker;
      walker = walker.parentElement;
    }
    return node;
  }
  return document.body;
}

function insertPanel(anchor) {
  const panel = document.createElement("aside");
  panel.className = "hp-panel";
  panel.innerHTML = `
    <div class="hp-header">
      <span class="hp-title">Hiper Prices</span>
      <span class="hp-state">a carregar</span>
    </div>
    <div class="hp-body"></div>
  `;
  if (anchor === document.body) {
    panel.classList.add("hp-panel-floating");
    document.body.appendChild(panel);
    return panel;
  }
  anchor.insertAdjacentElement("afterend", panel);
  // If the host layout squeezes the panel, fall back to floating mode.
  if (panel.getBoundingClientRect().width < MIN_ANCHOR_WIDTH) {
    panel.remove();
    panel.classList.add("hp-panel-floating");
    document.body.appendChild(panel);
  }
  return panel;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "Accept": "application/json" },
    credentials: "omit"
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    credentials: "omit",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const responseBody = await response.json().catch(() => ({}));
    throw new Error(responseBody.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function formatEuro(value) {
  if (value === null || value === undefined) return "--";
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: "EUR"
  }).format(Number(value));
}

function formatDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function trendLabel(value) {
  if (value === null || value === undefined) return "--";
  if (Number(value) === 0) return "sem alteracao";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${formatEuro(value)}`;
}

function sortByPrice(matches, { onlyCheaper = false } = {}) {
  let filtered = matches.filter((item) => item.latest && item.latest.price !== null);
  if (onlyCheaper) {
    filtered = filtered.filter((item) => item.price_delta !== null && item.price_delta < 0);
  }
  return filtered
    .sort((a, b) => {
      const da = a.price_delta ?? 0;
      const db = b.price_delta ?? 0;
      return da - db;
    })
    .slice(0, 5);
}

function deltaLabel(delta) {
  if (delta === null || delta === undefined) return "";
  const value = Number(delta);
  if (value === 0) return "mesmo preco";
  return value < 0
    ? `${formatEuro(Math.abs(value))} menos`
    : `${formatEuro(value)} mais`;
}

function deltaClass(delta) {
  if (delta === null || delta === undefined) return "hp-saving hp-saving-flat";
  if (Number(delta) < 0) return "hp-saving hp-saving-cheaper";
  if (Number(delta) > 0) return "hp-saving hp-saving-pricier";
  return "hp-saving hp-saving-flat";
}

function renderMatchList(items, emptyLabel) {
  if (!items.length) {
    return `<p class="hp-muted">${emptyLabel}</p>`;
  }
  return `
    <ul class="hp-match-list">
      ${items.map((item) => `
        <li>
          <a href="${item.detail_url}" target="_blank" rel="noopener noreferrer">
            <span class="hp-retailer">${item.retailer}</span>
            <span class="hp-match-name">${item.name || item.sku}</span>
          </a>
          <span class="hp-match-price">${formatEuro(item.latest.price)}</span>
          <span class="${deltaClass(item.price_delta)}">${deltaLabel(item.price_delta)}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

const CHART_RANGES = [
  { id: "1w", label: "1S", days: 7 },
  { id: "1m", label: "1M", days: 30 },
  { id: "1y", label: "1A", days: 365 },
  { id: "all", label: "Tudo", days: null },
];

function filterHistoryByDays(history, days) {
  if (!days) return history.slice();
  const cutoff = Date.now() - days * 86400000;
  return history.filter((h) => {
    const t = new Date(h.observed_at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

function renderChartSvg(history) {
  const points = history
    .map((h) => ({ t: new Date(h.observed_at).getTime(), p: Number(h.price) }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.p))
    .sort((a, b) => a.t - b.t);

  const W = 360, H = 90, PAD_X = 6, PAD_Y = 12;
  if (points.length === 0) {
    return `<svg class="hp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <text x="${W/2}" y="${H/2}" text-anchor="middle" class="hp-chart-empty">sem dados no intervalo</text>
    </svg>`;
  }
  if (points.length === 1) {
    return `<svg class="hp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <circle cx="${W/2}" cy="${H/2}" r="3" class="hp-chart-dot"/>
      <text x="${W/2}" y="${H/2 - 8}" text-anchor="middle" class="hp-chart-label">${formatEuro(points[0].p)}</text>
    </svg>`;
  }

  const tMin = points[0].t, tMax = points[points.length - 1].t;
  const tSpan = Math.max(tMax - tMin, 1);
  const prices = points.map((d) => d.p);
  const pMin = Math.min(...prices), pMax = Math.max(...prices);
  const pSpan = Math.max(pMax - pMin, 0.01);

  const innerW = W - 2 * PAD_X;
  const innerH = H - 2 * PAD_Y;
  const xs = (t) => PAD_X + ((t - tMin) / tSpan) * innerW;
  const ys = (p) => PAD_Y + (1 - (p - pMin) / pSpan) * innerH;

  const linePath = points.map((d, i) => `${i === 0 ? "M" : "L"} ${xs(d.t).toFixed(1)} ${ys(d.p).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${xs(points[points.length - 1].t).toFixed(1)} ${(H - PAD_Y).toFixed(1)} L ${xs(points[0].t).toFixed(1)} ${(H - PAD_Y).toFixed(1)} Z`;

  const last = points[points.length - 1];
  const lastX = xs(last.t), lastY = ys(last.p);

  const minLabelY = ys(pMin);
  const maxLabelY = ys(pMax);
  return `<svg class="hp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${areaPath}" class="hp-chart-area"/>
    <path d="${linePath}" class="hp-chart-line"/>
    <circle cx="${lastX}" cy="${lastY}" r="3" class="hp-chart-dot"/>
    <text x="${PAD_X}" y="${Math.max(maxLabelY - 4, 10)}" class="hp-chart-label hp-chart-label-max">${formatEuro(pMax)}</text>
    <text x="${PAD_X}" y="${Math.min(minLabelY + 10, H - 2)}" class="hp-chart-label hp-chart-label-min">${formatEuro(pMin)}</text>
  </svg>`;
}

function renderChartButtons(activeId) {
  return CHART_RANGES.map((r) => `
    <button type="button" class="hp-chart-btn${r.id === activeId ? " hp-chart-btn-active" : ""}" data-range="${r.id}">${r.label}</button>
  `).join("");
}

function attachChart(panel, history) {
  const container = panel.querySelector(".hp-chart-container");
  if (!container) return;
  const buttons = panel.querySelector(".hp-chart-buttons");
  const draw = (rangeId) => {
    const range = CHART_RANGES.find((r) => r.id === rangeId) || CHART_RANGES[1];
    const filtered = filterHistoryByDays(history, range.days);
    container.innerHTML = renderChartSvg(filtered);
    buttons.querySelectorAll(".hp-chart-btn").forEach((b) => {
      b.classList.toggle("hp-chart-btn-active", b.dataset.range === rangeId);
    });
  };
  buttons.addEventListener("click", (e) => {
    const btn = e.target.closest(".hp-chart-btn");
    if (!btn) return;
    draw(btn.dataset.range);
  });
  draw("1m");
}

function renderPanel(panel, productPayload, matchesPayload, historyPayload) {
  const latest = productPayload.latest;
  const summary = productPayload.history_summary;
  const sameAll = sortByPrice(matchesPayload.same_product || []);
  const comparableCheaper = sortByPrice(matchesPayload.comparable_alternatives || [], { onlyCheaper: true });
  const history = historyPayload?.history || [];

  panel.querySelector(".hp-state").textContent = latest ? "com dados" : "sem dados";
  panel.querySelector(".hp-body").innerHTML = `
    <div class="hp-current">
      <div>
        <span class="hp-label">Preco registado</span>
        <strong>${formatEuro(latest?.price)}</strong>
      </div>
      <div>
        <span class="hp-label">Ultima leitura</span>
        <strong>${formatDate(latest?.observed_at)}</strong>
      </div>
    </div>
    <div class="hp-stats">
      <span>30d min ${formatEuro(summary.min_price_30d)}</span>
      <span>30d max ${formatEuro(summary.max_price_30d)}</span>
      <span>tendencia ${trendLabel(summary.trend_30d)}</span>
    </div>
    <section class="hp-chart-section">
      <div class="hp-chart-buttons">${renderChartButtons("1m")}</div>
      <div class="hp-chart-container"></div>
    </section>
    <section>
      <h2>Mesmo produto</h2>
      ${renderMatchList(sameAll, "Sem equivalentes noutros supermercados.")}
    </section>
    <section>
      <h2>Alternativas</h2>
      ${renderMatchList(comparableCheaper, "Sem alternativa mais barata.")}
    </section>
    <a class="hp-detail-link" href="${productPayload.links.html}" target="_blank" rel="noopener noreferrer">
      Ver historico completo
    </a>
  `;
  attachChart(panel, history);
}

function renderError(panel, message) {
  panel.querySelector(".hp-state").textContent = "indisponivel";
  panel.querySelector(".hp-body").innerHTML = `
    <p class="hp-muted">${message}</p>
  `;
}

function renderBasketPanel(panel, payload) {
  const sameSavings = payload.savings_same_product || 0;
  const comparableSavings = payload.savings_comparable_alternative || 0;
  const usefulItems = payload.items
    .filter((item) => (
      (item.savings_same_product || 0) > 0
      || (item.savings_comparable_alternative || 0) > 0
    ))
    .slice(0, 5);

  panel.querySelector(".hp-state").textContent = `${payload.priced_item_count}/${payload.item_count}`;
  panel.querySelector(".hp-body").innerHTML = `
    <div class="hp-current">
      <div>
        <span class="hp-label">Total registado</span>
        <strong>${formatEuro(payload.baseline_total)}</strong>
      </div>
      <div>
        <span class="hp-label">Poupanca possivel</span>
        <strong>${formatEuro(Math.max(sameSavings, comparableSavings))}</strong>
      </div>
    </div>
    <div class="hp-stats">
      <span>mesmo produto ${formatEuro(sameSavings)}</span>
      <span>alternativas ${formatEuro(comparableSavings)}</span>
      <span>${payload.priced_item_count} com preco</span>
    </div>
    <section>
      <h2>Melhores trocas</h2>
      ${renderBasketItems(usefulItems)}
    </section>
  `;
}

function renderBasketItems(items) {
  if (!items.length) {
    return `<p class="hp-muted">Sem poupanca encontrada nos produtos visiveis.</p>`;
  }
  return `
    <ul class="hp-match-list hp-basket-list">
      ${items.map((item) => {
        const savings = Math.max(
          item.savings_same_product || 0,
          item.savings_comparable_alternative || 0
        );
        const best = (item.savings_comparable_alternative || 0) > (item.savings_same_product || 0)
          ? item.cheapest_comparable_alternative
          : item.cheapest_same_product;
        return `
          <li>
            <span class="hp-match-name">${item.product?.name || item.sku}</span>
            <span class="hp-match-price">${formatEuro(savings)}</span>
            <span class="hp-saving">${best?.retailer || ""} ${best?.name || ""}</span>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

async function renderBasketIfUseful(retailer, config, apiBase) {
  const items = scanVisibleSkus(config);
  if (items.length < 2 || document.querySelector(".hp-panel")) return;
  const panel = insertPanel(document.body);
  panel.classList.add("hp-panel-floating");
  panel.querySelector(".hp-title").textContent = "Hiper basket";
  panel.querySelector(".hp-state").textContent = "a comparar";
  try {
    const payload = await postJson(`${apiBase}/api/v1/basket/compare`, {
      retailer,
      items
    });
    renderBasketPanel(panel, payload);
  } catch (error) {
    renderError(panel, error.message || "Nao foi possivel comparar.");
  }
}

async function main() {
  const retailerPage = detectRetailer();
  if (!retailerPage) return;
  const { apiBase: configuredApiBase } = await getConfig();
  const apiBase = configuredApiBase.replace(/\/$/, "");
  const page = detectPage();
  if (!page) {
    await renderBasketIfUseful(retailerPage.retailer, retailerPage.config, apiBase);
    return;
  }
  if (document.querySelector(".hp-panel")) return;

  const panel = insertPanel(findAnchor(page.config));
  const base = `${apiBase}/api/v1/products/${page.retailer}/${page.sku}`;

  try {
    const [productPayload, matchesPayload, historyPayload] = await Promise.all([
      fetchJson(base),
      fetchJson(`${base}/matches`),
      fetchJson(`${base}/history`).catch(() => ({ history: [] }))
    ]);
    renderPanel(panel, productPayload, matchesPayload, historyPayload);
  } catch (error) {
    renderError(panel, error.message || "Nao foi possivel carregar dados.");
  }
}

main();
