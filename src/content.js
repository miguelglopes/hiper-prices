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

// One stable UUID per browser, persisted in chrome.storage.local. Not
// linked to the web UI's cookie — different origin, different vote
// identity. The backend treats them as independent voters which is fine
// for our consensus filter.
function getVoterId() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get({ voterId: null }, ({ voterId }) => {
      if (voterId) {
        resolve(voterId);
        return;
      }
      const minted = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`)
        .replace(/-/g, "");
      chrome.storage.local.set({ voterId: minted }, () => resolve(minted));
    });
  });
}

function detectPage() {
  const config = RETAILERS[window.location.hostname];
  if (!config) return null;
  const match = extractSku(window.location.href, config);
  if (!match) return null;
  return { retailer: config.id, sku: match, config };
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

async function fetchJson(url, voterId) {
  const headers = { "Accept": "application/json" };
  if (voterId) headers["X-Voter-Id"] = voterId;
  const response = await fetch(url, { headers, credentials: "omit" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function postJson(url, body, voterId) {
  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  if (voterId) headers["X-Voter-Id"] = voterId;
  const response = await fetch(url, {
    method: "POST",
    headers,
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
  // Prefer per-unit (€/L) for sorting and the "cheaper" gate. Falls
  // back to absolute price when units differ. A 4-pack at lower
  // absolute price is not actually cheaper if it costs more per litre.
  const score = (item) => {
    const v = item.price_per_unit_delta ?? item.price_delta ?? 0;
    return v;
  };
  let filtered = matches.filter((item) => item.latest && item.latest.price !== null);
  if (onlyCheaper) {
    filtered = filtered.filter((item) => score(item) < 0);
  }
  return filtered
    .sort((a, b) => score(a) - score(b))
    .slice(0, 8);
}

function deltaLabel(delta, unitSuffix = "") {
  if (delta === null || delta === undefined) return "";
  const value = Number(delta);
  if (value === 0) return "mesmo preco";
  const formatted = formatEuro(Math.abs(value));
  return value < 0
    ? `-${formatted}${unitSuffix}`
    : `+${formatted}${unitSuffix}`;
}

function deltaClass(delta) {
  if (delta === null || delta === undefined) return "hp-saving hp-saving-flat";
  if (Number(delta) < 0) return "hp-saving hp-saving-cheaper";
  if (Number(delta) > 0) return "hp-saving hp-saving-pricier";
  return "hp-saving hp-saving-flat";
}

// Prefer €/unit comparison when both sides have it (units already match
// because /matches only returns price_per_unit_delta when they do).
// Falls back to absolute price diff so we always render *something*.
function pickDelta(item) {
  if (item.price_per_unit_delta !== null && item.price_per_unit_delta !== undefined) {
    return {
      value: item.price_per_unit_delta,
      unitSuffix: item.latest?.unit_primary ? `/${item.latest.unit_primary}` : "",
    };
  }
  return { value: item.price_delta, unitSuffix: "" };
}

function renderMatchList(items, emptyLabel) {
  if (!items.length) {
    return `<p class="hp-muted">${emptyLabel}</p>`;
  }
  return `
    <ul class="hp-match-list">
      ${items.map((item) => {
        const fb = item.feedback || { up: 0, down: 0, mine: null };
        const upActive = fb.mine === 1 ? " hp-vote-active" : "";
        const downActive = fb.mine === -1 ? " hp-vote-active" : "";
        const delta = pickDelta(item);
        const pp = item.latest?.price_per_primary;
        const unit = item.latest?.unit_primary;
        const unitPriceLabel = pp != null && unit
          ? `${formatEuro(pp)}/${unit}`
          : "";
        // 2-row card. Top row: name | headline (diff above €/L).
        // Bottom row: absolute price + actions. Diff is the loudest
        // element — that's the actual decision-driver.
        const diffLabel = deltaLabel(delta.value, delta.unitSuffix);
        return `
        <li class="hp-match-row">
          <a class="hp-match-link" href="${item.detail_url}" target="_blank" rel="noopener noreferrer">
            <span class="hp-retailer">${item.retailer}</span>
            <span class="hp-match-name">${item.name || item.sku}</span>
          </a>
          <div class="hp-match-headline">
            ${diffLabel
              ? `<span class="${deltaClass(delta.value)}">${diffLabel}</span>`
              : ""}
            ${unitPriceLabel
              ? `<span class="hp-match-unit-price">${unitPriceLabel}</span>`
              : ""}
          </div>
          <div class="hp-match-footer">
            <span class="hp-match-price">${formatEuro(item.latest.price)}</span>
            <span class="hp-actions">
              <button type="button" class="hp-cart-btn"
                      data-peer-retailer="${item.retailer}"
                      data-peer-sku="${item.sku}"
                      data-peer-url="${item.product_url || ''}"
                      title="Adicionar ao carrinho ${item.retailer}">+ carrinho</button>
              <button type="button" class="hp-vote-btn hp-vote-up${upActive}"
                      data-vote="1" data-peer-retailer="${item.retailer}" data-peer-sku="${item.sku}"
                      title="É o mesmo / boa alternativa">👍 ${fb.up}</button>
              <button type="button" class="hp-vote-btn hp-vote-down${downActive}"
                      data-vote="-1" data-peer-retailer="${item.retailer}" data-peer-sku="${item.sku}"
                      title="Não é igual / má alternativa">👎 ${fb.down}</button>
            </span>
          </div>
        </li>
        `;
      }).join("")}
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

function attachVoteHandlers(panel, ctx) {
  const { retailer, sku, apiBase, voterId, refresh } = ctx;
  panel.addEventListener("click", async (e) => {
    const btn = e.target.closest(".hp-vote-btn");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const peerRetailer = btn.dataset.peerRetailer;
    const peerSku = btn.dataset.peerSku;
    const requested = parseInt(btn.dataset.vote, 10);
    // Toggle: if the active button is clicked again, send 0 to clear.
    const isActive = btn.classList.contains("hp-vote-active");
    const finalVote = isActive ? 0 : requested;
    btn.disabled = true;
    try {
      await postJson(`${apiBase}/api/v1/matches/feedback`, {
        retailer, sku,
        peer_retailer: peerRetailer, peer_sku: peerSku,
        vote: finalVote
      }, voterId);
      await refresh();
    } catch (err) {
      btn.disabled = false;
      console.warn("hiper-prices vote failed", err);
    }
  });
}

function sendAddToCart(payload) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      resolve({ ok: false, reason: "no_runtime" });
      return;
    }
    chrome.runtime.sendMessage({ type: "hp:addToCart", ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: "runtime_error", message: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: "no_response" });
    });
  });
}

function setCartBtnState(btn, state) {
  const original = btn.dataset.originalText || btn.textContent;
  btn.dataset.originalText = original;
  btn.classList.remove("hp-cart-ok", "hp-cart-err");
  switch (state.kind) {
    case "loading":
      btn.disabled = true;
      btn.textContent = "...";
      break;
    case "ok":
      btn.disabled = true;
      btn.textContent = "✓ adicionado";
      btn.classList.add("hp-cart-ok");
      break;
    case "err":
      btn.disabled = false;
      btn.textContent = state.label || "✗ falhou";
      btn.title = state.title || "Não foi possível adicionar.";
      btn.classList.add("hp-cart-err");
      break;
    default:
      btn.disabled = false;
      btn.textContent = original;
  }
}

function attachCartHandlers(panel) {
  panel.addEventListener("click", async (e) => {
    const btn = e.target.closest(".hp-cart-btn");
    if (!btn || btn.disabled) return;
    e.preventDefault();
    const retailer = btn.dataset.peerRetailer;
    const sku = btn.dataset.peerSku;
    const productUrl = btn.dataset.peerUrl;
    setCartBtnState(btn, { kind: "loading" });
    const result = await sendAddToCart({ retailer, sku, productUrl });
    if (result.ok) {
      setCartBtnState(btn, { kind: "ok" });
      return;
    }
    if (result.reason === "postal_code") {
      setCartBtnState(btn, {
        kind: "err",
        label: "define loja",
        title: "Pingo Doce exige escolher loja primeiro. Abre pingodoce.pt e seleciona uma loja.",
      });
      return;
    }
    setCartBtnState(btn, {
      kind: "err",
      label: "✗ falhou",
      title: result.message || result.reason || "Erro desconhecido",
    });
    console.warn("hiper-prices add-to-cart failed", result);
  });
}

function renderPanel(panel, productPayload, matchesPayload, historyPayload, ctx) {
  const latest = productPayload.latest;
  const summary = productPayload.history_summary;
  const sameAll = sortByPrice(matchesPayload.same_product || []);
  // Show all comparable alternatives, sorted cheapest €/L first. The
  // diff badge's colour already conveys cheaper / pricier — filtering
  // pricier ones out (the previous `onlyCheaper: true` behaviour) hid
  // valid matches like a peer-retailer's same-category product whose
  // unit price happens to be a cent higher.
  const comparableCheaper = sortByPrice(matchesPayload.comparable_alternatives || []);
  const history = historyPayload?.history || [];

  panel.querySelector(".hp-state").textContent = latest ? "com dados" : "sem dados";
  // 'Ultima leitura' deliberately not shown — a stale read is misleading
  // when the price hasn't changed (the value is still current). 30d
  // min/max/trend duplicate what the chart's y-axis labels already show.
  panel.querySelector(".hp-body").innerHTML = `
    <div class="hp-current">
      <div>
        <span class="hp-label">Preco registado</span>
        <strong>${formatEuro(latest?.price)}</strong>
      </div>
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
      ${renderMatchList(comparableCheaper, "Sem alternativas comparáveis.")}
    </section>
    <a class="hp-detail-link" href="${productPayload.links.html}" target="_blank" rel="noopener noreferrer">
      Ver historico completo
    </a>
  `;
  attachChart(panel, history);
  if (ctx) attachVoteHandlers(panel, ctx);
  attachCartHandlers(panel);
}

function renderError(panel, message) {
  panel.querySelector(".hp-state").textContent = "indisponivel";
  panel.querySelector(".hp-body").innerHTML = `
    <p class="hp-muted">${message}</p>
  `;
}

async function main() {
  const page = detectPage();
  if (!page) return;
  if (document.querySelector(".hp-panel")) return;
  const [{ apiBase: configuredApiBase }, voterId] = await Promise.all([
    getConfig(),
    getVoterId()
  ]);
  const apiBase = configuredApiBase.replace(/\/$/, "");

  const panel = insertPanel(findAnchor(page.config));
  const base = `${apiBase}/api/v1/products/${page.retailer}/${page.sku}`;

  // re-fetch matches + product + history and re-render. Used after a
  // vote so the count and the active-button state update.
  const refresh = async () => {
    try {
      const [productPayload, matchesPayload, historyPayload] = await Promise.all([
        fetchJson(base, voterId),
        fetchJson(`${base}/matches`, voterId),
        fetchJson(`${base}/history`, voterId).catch(() => ({ history: [] }))
      ]);
      renderPanel(panel, productPayload, matchesPayload, historyPayload, {
        retailer: page.retailer, sku: page.sku, apiBase, voterId, refresh
      });
    } catch (error) {
      renderError(panel, error.message || "Nao foi possivel carregar dados.");
    }
  };

  await refresh();
}

main();
