const DEFAULT_API_BASE = "https://hiper-prices.mglopes.com";

// Real cart paths verified via Playwright on 2026-05-09:
//   continente: redirects /cart -> /checkout/carrinho/
//   auchan:     /pt/cart -> /pt/carrinho-compras
//   pingodoce:  Cart-Show controller (no vanity alias found)
// Each pattern keeps a fallback or two in case the retailer adds an alias
// (e.g. `/cart`) so we don't silently miss the cart on URL drift.
const RETAILERS = {
  "www.continente.pt": {
    id: "continente",
    label: "Continente",
    skuPattern: /\/produto\/.+-(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".pwc-tile--price-primary",
      ".product-detail .prices",
      ".product-info",
      "main"
    ],
    basketPathPattern: /^\/(checkout\/carrinho|carrinho|cart)(\/|$|\?)/i
  },
  "www.auchan.pt": {
    id: "auchan",
    label: "Auchan",
    skuPattern: /\/pt\/.+\/(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".product-detail .prices",
      ".product-detail .price",
      ".product-detail",
      ".product-wrapper"
    ],
    basketPathPattern: /^\/(?:pt\/)?(carrinho-compras|carrinho|cart)(\/|$|\?)/i
  },
  "www.pingodoce.pt": {
    id: "pingodoce",
    label: "Pingo Doce",
    skuPattern: /-(\d+)\.html(?:[?#].*)?$/,
    anchors: [
      ".product-price",
      ".product-wrapper",
      ".product-detail",
      "main"
    ],
    basketPathPattern: /^\/(?:on\/demandware\.store\/Sites-pingo-doce-Site\/[^/]+\/Cart-Show|carrinho|cart|cesto)(\/|$|\?)/i
  }
};

const RETAILER_LABELS = {
  continente: "Continente",
  auchan: "Auchan",
  pingodoce: "Pingo Doce"
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

// Builds the headline diff badge for a match row. Returns an HTML
// string (or empty string) so the caller can drop it inline. Three
// states:
//  - cheaper / pricier → "-0,07 €/L" or "+0,07 €/L", color-coded text;
//  - equal             → small grey "=" chip with tooltip carrying the
//                        precise meaning ("mesmo €/L", "mesmo preço")
//                        — way less noise than the words at row scale.
function renderDeltaBadge(delta) {
  if (delta.value === null || delta.value === undefined) return "";
  const value = Number(delta.value);
  if (value === 0) {
    const label = delta.unitSuffix ? `mesmo €${delta.unitSuffix}` : "mesmo preço";
    return `<span class="hp-saving hp-saving-equal" title="${label}" aria-label="${label}">=</span>`;
  }
  const formatted = formatEuro(Math.abs(value));
  const sign = value < 0 ? "-" : "+";
  const cls = value < 0 ? "hp-saving hp-saving-cheaper" : "hp-saving hp-saving-pricier";
  return `<span class="${cls}">${sign}${formatted}${delta.unitSuffix}</span>`;
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
        const thumbHtml = item.thumb_url
          ? `<img class="hp-match-thumb" src="${item.thumb_url}" alt="" loading="lazy" width="36" height="36">`
          : "";
        return `
        <li class="hp-match-row${item.thumb_url ? " hp-match-row-with-thumb" : ""}">
          <a class="hp-match-link" href="${item.detail_url}" target="_blank" rel="noopener noreferrer">
            ${thumbHtml}
            <span class="hp-match-link-text">
              <span class="hp-retailer">${item.retailer}</span>
              <span class="hp-match-name">${item.name || item.sku}</span>
            </span>
          </a>
          <div class="hp-match-headline">
            ${renderDeltaBadge(delta)}
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
              <span class="hp-vote-help" tabindex="0"
                    title="É uma boa sugestão?"
                    aria-label="É uma boa sugestão?">?</span>
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

// Nutrition table for the panel. Renders only when at least one
// per-100g value is set. Mirrors the rows from product.html so the
// extension and web UI stay in sync (per CLAUDE.md parity rule).
function renderNutrition(nutrition) {
  if (!nutrition) return "";
  const rows = [
    ["Energia", nutrition.energy_kcal, "kcal", false],
    ["Lípidos", nutrition.fat_g, "g", false],
    ["dos quais saturados", nutrition.sat_fat_g, "g", true],
    ["Hidratos de carbono", nutrition.carbs_g, "g", false],
    ["dos quais açúcares", nutrition.sugars_g, "g", true],
    ["Fibra", nutrition.fiber_g, "g", false],
    ["Proteínas", nutrition.protein_g, "g", false],
    ["Sal", nutrition.salt_g, "g", false],
  ].filter(([, v]) => v !== null && v !== undefined);
  if (!rows.length) return "";
  const fmt = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 2 });
  return `
    <details class="hp-nutrition">
      <summary>Informação nutricional <span class="hp-nutrition-hint">por 100 g/ml</span></summary>
      <table class="hp-nutrition-table">
        <tbody>
          ${rows.map(([label, value, unit, sub]) => `
            <tr${sub ? ' class="hp-nutrient-sub"' : ""}>
              <th>${label}</th>
              <td>${fmt.format(Number(value))} ${unit}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </details>
  `;
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
  // Hide the chart entirely when there's <2 observations — a single-point
  // chart with the value floating in the middle looks broken. 'Ultima
  // leitura' / 30d stats are intentionally absent (stale read is
  // misleading; min/max are visible on the chart's y-axis labels).
  const showChart = history.length >= 2;
  panel.querySelector(".hp-body").innerHTML = `
    <div class="hp-current">
      <div>
        <span class="hp-label">Preco registado</span>
        <strong>${formatEuro(latest?.price)}</strong>
      </div>
    </div>
    ${showChart
      ? `<section class="hp-chart-section">
           <div class="hp-chart-buttons">${renderChartButtons("1m")}</div>
           <div class="hp-chart-container"></div>
         </section>`
      : `<p class="hp-muted">Histórico insuficiente para gráfico.</p>`}
    ${renderNutrition(productPayload.nutrition)}
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
  if (showChart) attachChart(panel, history);
  if (ctx) attachVoteHandlers(panel, ctx);
  attachCartHandlers(panel);
}

function renderError(panel, message) {
  panel.querySelector(".hp-state").textContent = "indisponivel";
  panel.querySelector(".hp-body").innerHTML = `
    <p class="hp-muted">${message}</p>
  `;
}

// --- basket page ---------------------------------------------------------

function detectBasketPage() {
  const config = RETAILERS[window.location.hostname];
  if (!config || !config.basketPathPattern) return null;
  if (!config.basketPathPattern.test(window.location.pathname)) return null;
  // PDP detection wins if both somehow match (shouldn't happen, but be
  // defensive — a PDP URL shouldn't pass basketPathPattern anyway).
  if (config.skuPattern.test(window.location.pathname)) return null;
  return { retailer: config.id, config };
}

// Walk the basket DOM and return [{sku, quantity, name}]. Robust strategy:
// any anchor whose href matches the retailer's PDP skuPattern is treated
// as a line-item link. We dedupe by sku. Quantity comes from a qty input
// scoped to *this* line item only — see closestLineItem for the bound.
function scrapeBasketItems(config) {
  const found = new Map();   // sku -> { sku, quantity, name }
  for (const a of document.querySelectorAll('a[href]')) {
    let pathname;
    try { pathname = new URL(a.href, window.location.origin).pathname; }
    catch { continue; }
    const m = pathname.match(config.skuPattern);
    if (!m) continue;
    const sku = m[1];
    if (found.has(sku)) continue;

    const lineEl = closestLineItem(a, config.skuPattern);
    const qty = readQuantity(lineEl) ?? 1;
    const name = (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) || null;
    found.set(sku, { sku, quantity: qty, name });
  }
  return [...found.values()];
}

function closestLineItem(node, skuPattern) {
  // Walk upward only while the ancestor contains a *single* SKU's worth
  // of PDP links — i.e., still scoped to this one line item. Once the
  // walker encloses ≥2 distinct SKUs we've stepped into the cart-list
  // container, so back off one level. This stops a qty-less item from
  // borrowing a sibling's qty input via a shared parent.
  let walker = node.parentElement;
  let last = node;
  for (let i = 0; i < 12 && walker && walker !== document.body; i++) {
    const distinct = new Set();
    for (const a of walker.querySelectorAll("a[href]")) {
      let pathname;
      try { pathname = new URL(a.href, window.location.origin).pathname; }
      catch { continue; }
      const m = pathname.match(skuPattern);
      if (m) distinct.add(m[1]);
      if (distinct.size > 1) break;
    }
    if (distinct.size > 1) return last;
    last = walker;
    walker = walker.parentElement;
  }
  return last;
}

function readQuantity(el) {
  if (!el) return null;
  const input = el.querySelector(
    'input[type="number"], input[name*="quantity" i], input[name*="qty" i], [data-quantity]'
  );
  if (input) {
    const raw = input.value || input.getAttribute("value") || input.dataset?.quantity;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Fallback: text like "x2" or "2 unid"
  const text = (el.textContent || "").match(/(?:^|[^\d])(\d{1,3})\s*(?:un|unid|x|×)\b/i)
    || (el.textContent || "").match(/(?:^|\b)x\s*(\d{1,3})\b/i);
  if (text) {
    const n = Number(text[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function insertBasketPanel() {
  const panel = document.createElement("aside");
  panel.className = "hp-panel hp-basket-panel hp-panel-floating";
  panel.innerHTML = `
    <div class="hp-header">
      <span class="hp-title">Hiper Prices · cesto</span>
      <span class="hp-state">a calcular</span>
    </div>
    <div class="hp-body"></div>
  `;
  document.body.appendChild(panel);
  return panel;
}

// View state held outside the render so toggle clicks survive re-renders
// triggered by basket DOM mutations.
const basketView = {
  includeComparable: true,
  excludeMissing: false,
  expandedPeer: null,
};

function renderBasketPanel(panel, payload, ctx) {
  const { retailer, baseline, peers, recommended } = payload;
  panel.querySelector(".hp-state").textContent =
    `${baseline.items.length} ${baseline.items.length === 1 ? "item" : "itens"}`;

  const totalKey = (peer) => {
    if (basketView.excludeMissing) {
      return basketView.includeComparable ? peer.total_with_comparable : peer.total_same;
    }
    return basketView.includeComparable
      ? peer.total_with_comparable_filled
      : peer.total_same_filled;
  };
  const missingKey = (peer) =>
    basketView.includeComparable ? peer.missing_any_skus : peer.missing_same_skus;

  const orderedPeers = peers.slice().sort((a, b) => totalKey(a) - totalKey(b));
  const winner = orderedPeers.find((p) => totalKey(p) < baseline.total) || null;

  panel.querySelector(".hp-body").innerHTML = `
    <div class="hp-current">
      <div>
        <span class="hp-label">${RETAILER_LABELS[retailer] || retailer} · cesto</span>
        <strong>${formatEuro(baseline.total)}</strong>
      </div>
      <div>
        <span class="hp-label">${baseline.items.length} produtos</span>
      </div>
    </div>
    ${recommended
      ? `<div class="hp-basket-reco">
           <strong>Mais barato no total: ${RETAILER_LABELS[recommended.retailer] || recommended.retailer}</strong>
           <span>Poupa ${formatEuro(recommended.savings)}${
             recommended.missing_count
               ? ` · ${recommended.missing_count} ${recommended.missing_count === 1 ? "produto sem correspondência" : "produtos sem correspondência"}`
               : ""
           }</span>
         </div>`
      : `<div class="hp-basket-reco hp-basket-reco-flat">
           <strong>Sem retalhista mais barato no total</strong>
           <span>Compara linha a linha em baixo.</span>
         </div>`}
    <div class="hp-basket-toggles">
      <label><input type="checkbox" data-toggle="includeComparable" ${
        basketView.includeComparable ? "checked" : ""
      }> Incluir alternativas similares</label>
      <label><input type="checkbox" data-toggle="excludeMissing" ${
        basketView.excludeMissing ? "checked" : ""
      }> Excluir produtos sem correspondência (recalcular)</label>
    </div>
    <div class="hp-basket-peers">
      ${orderedPeers.map((peer) => renderPeerCard(peer, baseline, totalKey(peer), missingKey(peer), winner === peer)).join("")}
    </div>
  `;
  attachBasketHandlers(panel, payload, ctx);
}

function renderPeerCard(peer, baseline, total, missingSkus, isWinner) {
  const delta = total - baseline.total;
  const deltaText = delta === 0 ? "mesmo preço"
    : delta < 0 ? `poupas ${formatEuro(Math.abs(delta))}`
    : `mais ${formatEuro(delta)}`;
  const deltaClassName = delta < 0 ? "hp-saving-cheaper"
    : delta > 0 ? "hp-saving-pricier"
    : "hp-saving-flat";
  const expanded = basketView.expandedPeer === peer.retailer;
  const matchedItems = peer.items.filter(
    (it) => it.same_product || (basketView.includeComparable && it.comparable_alternative)
  );
  return `
    <section class="hp-peer-card${isWinner ? " hp-peer-winner" : ""}" data-peer="${peer.retailer}">
      <header class="hp-peer-head">
        <div>
          <span class="hp-peer-name">${RETAILER_LABELS[peer.retailer] || peer.retailer}</span>
          ${isWinner ? `<span class="hp-peer-badge">mais barato</span>` : ""}
        </div>
        <div class="hp-peer-totals">
          <strong>${formatEuro(total)}</strong>
          <span class="hp-saving ${deltaClassName}">${deltaText}</span>
        </div>
      </header>
      <div class="hp-peer-meta">
        ${missingSkus.length
          ? `<span class="hp-peer-missing">${missingSkus.length} sem correspondência</span>`
          : `<span class="hp-peer-allmatched">todos com correspondência</span>`}
        <button type="button" class="hp-peer-bulk-btn" data-peer="${peer.retailer}"
                ${matchedItems.length === 0 ? "disabled" : ""}>
          + adicionar ${matchedItems.length} ao carrinho ${RETAILER_LABELS[peer.retailer] || peer.retailer}
        </button>
        <button type="button" class="hp-peer-toggle" data-peer="${peer.retailer}">
          ${expanded ? "ocultar produtos" : "ver produtos"}
        </button>
      </div>
      ${expanded ? renderPeerItems(peer, baseline) : ""}
    </section>
  `;
}

function renderPeerItems(peer, baseline) {
  const baselineBySku = new Map(baseline.items.map((it) => [it.sku, it]));
  return `
    <ul class="hp-peer-items">
      ${peer.items.map((item) => {
        const base = baselineBySku.get(item.sku);
        const same = item.same_product;
        const comp = item.comparable_alternative;
        const chosen = same || (basketView.includeComparable ? comp : null);
        const status = same ? "mesmo produto"
          : (basketView.includeComparable && comp) ? "alternativa similar"
          : "sem correspondência";
        const statusClass = same ? "hp-peer-status-same"
          : (basketView.includeComparable && comp) ? "hp-peer-status-comp"
          : "hp-peer-status-missing";
        const chosenLine = chosen?.line_total;
        const baseLine = base?.line_total;
        const lineDelta = chosenLine != null && baseLine != null
          ? chosenLine - baseLine
          : null;
        return `
        <li class="hp-peer-item">
          <div class="hp-peer-item-name">
            ${chosen?.detail_url
              ? `<a href="${chosen.detail_url}" target="_blank" rel="noopener noreferrer">${chosen.name || item.sku}</a>`
              : `<span class="hp-muted">${base?.name || item.sku}</span>`}
            <span class="hp-peer-item-qty">x${item.quantity}</span>
          </div>
          <div class="hp-peer-item-status ${statusClass}">${status}</div>
          <div class="hp-peer-item-prices">
            <span class="hp-peer-item-base">${formatEuro(baseLine)}</span>
            <span class="hp-peer-item-arrow">→</span>
            <span class="hp-peer-item-peer">${chosen ? formatEuro(chosenLine) : "—"}</span>
            ${lineDelta != null
              ? `<span class="hp-saving ${lineDelta < 0 ? "hp-saving-cheaper" : lineDelta > 0 ? "hp-saving-pricier" : "hp-saving-flat"}">${
                  lineDelta === 0 ? "0,00 €"
                  : (lineDelta < 0 ? "-" : "+") + formatEuro(Math.abs(lineDelta))
                }</span>`
              : ""}
          </div>
        </li>`;
      }).join("")}
    </ul>
  `;
}

function attachBasketHandlers(panel, payload, ctx) {
  panel.querySelectorAll('input[data-toggle]').forEach((input) => {
    input.addEventListener("change", () => {
      basketView[input.dataset.toggle] = input.checked;
      renderBasketPanel(panel, payload, ctx);
    });
  });
  panel.querySelectorAll(".hp-peer-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const peer = btn.dataset.peer;
      basketView.expandedPeer = basketView.expandedPeer === peer ? null : peer;
      renderBasketPanel(panel, payload, ctx);
    });
  });
  panel.querySelectorAll(".hp-peer-bulk-btn").forEach((btn) => {
    btn.addEventListener("click", () => onBulkAdd(btn, payload));
  });
}

async function onBulkAdd(btn, payload) {
  const peerId = btn.dataset.peer;
  const peer = payload.peers.find((p) => p.retailer === peerId);
  if (!peer) return;
  const lines = peer.items
    .map((item) => {
      const chosen = item.same_product
        || (basketView.includeComparable ? item.comparable_alternative : null);
      if (!chosen) return null;
      return {
        retailer: peerId,
        sku: chosen.sku,
        productUrl: chosen.product_url,
        quantity: Math.max(1, Math.round(item.quantity)),
      };
    })
    .filter(Boolean);
  if (!lines.length) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = `a adicionar 0/${lines.length}...`;

  const result = await sendBulkAddToCart(lines, (done) => {
    btn.textContent = `a adicionar ${done}/${lines.length}...`;
  });
  if (result.ok) {
    btn.textContent = `✓ ${result.successes.length} adicionados`;
    btn.classList.add("hp-cart-ok");
  } else {
    const okCount = (result.successes || []).length;
    btn.textContent = okCount
      ? `parcial: ${okCount}/${lines.length} (${result.failures?.length || 0} falharam)`
      : "✗ falhou";
    btn.classList.add("hp-cart-err");
    btn.disabled = false;
    console.warn("hiper-prices bulk add failed", result, "(restoring as", original, ")");
  }
}

function sendBulkAddToCart(lines, onProgress) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      resolve({ ok: false, reason: "no_runtime" });
      return;
    }
    const port = chrome.runtime.connect({ name: "hp:bulkAddToCart" });
    let done = 0;
    const successes = [];
    const failures = [];
    port.onMessage.addListener((msg) => {
      if (msg?.type === "progress") {
        done = msg.done;
        onProgress?.(done);
      } else if (msg?.type === "result") {
        if (msg.result?.ok) successes.push(msg.result);
        else failures.push(msg.result);
      } else if (msg?.type === "done") {
        port.disconnect();
        resolve({
          ok: failures.length === 0 && successes.length > 0,
          successes, failures,
        });
      }
    });
    port.onDisconnect.addListener(() => {
      // If we never got "done" (background errored), resolve as failure.
      if (done < lines.length) {
        resolve({ ok: false, reason: "disconnect", successes, failures });
      }
    });
    port.postMessage({ type: "start", lines });
  });
}

async function runBasketFlow() {
  const page = detectBasketPage();
  if (!page) return false;
  if (document.querySelector(".hp-basket-panel")) return true;

  const [{ apiBase: configuredApiBase }, voterId] = await Promise.all([
    getConfig(), getVoterId()
  ]);
  const apiBase = configuredApiBase.replace(/\/$/, "");
  const panel = insertBasketPanel();

  let lastSig = null;
  const refresh = async () => {
    const items = scrapeBasketItems(page.config);
    if (!items.length) {
      renderError(panel, "Cesto vazio (ou não foi possível identificar os produtos).");
      return;
    }
    const sig = items.map((it) => `${it.sku}x${it.quantity}`).sort().join("|");
    if (sig === lastSig) return;
    lastSig = sig;
    panel.querySelector(".hp-state").textContent = "a calcular...";
    try {
      const payload = await postJson(
        `${apiBase}/api/v1/basket/compare`,
        { retailer: page.retailer, items },
        voterId
      );
      renderBasketPanel(panel, payload, { apiBase, voterId, retailer: page.retailer });
    } catch (err) {
      renderError(panel, err.message || "Não foi possível calcular o cesto.");
    }
  };
  await refresh();

  // Re-scrape when the basket DOM changes (qty bumps, removals, SPA loads).
  // Debounced so we don't refire on every keystroke in the qty input.
  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["value", "data-quantity"] });

  return true;
}

async function main() {
  if (await runBasketFlow()) return;
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
