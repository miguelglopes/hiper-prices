// Shared price-history chart used by both the web product page and the
// browser-extension panel. This file is mirrored byte-for-byte at
// extension/src/chart.js (Chrome content scripts can only load files
// from inside the extension package, so the file has to live in two
// places). A pytest in tests/ asserts the two files stay identical —
// edit one and you must edit the other.
//
// API (window.HpChart):
//   buildData(history, opts)   → geometry + per-point hover data
//   renderChart(history)       → full chart HTML fragment
//   renderButtons(activeId)    → range-buttons HTML fragment
//   filterByDays(history, n)   → history filtered to the last n days
//   attach(host, history, opts)→ render + wire buttons inside `host`
//   boot(root)                 → auto-attach every .hp-chart-host found
//
// DOM contract: a host element with class `hp-chart-host`. attach()
// fills it with `.hp-chart-buttons` + `.hp-chart-container`; the
// container then holds the SVG + hover markers (see content.css /
// style.css `.hp-chart-*` rules — also kept in sync between surfaces).
//
// Web entry: a `.hp-chart-host` with a `data-history` JSON attribute
// is auto-attached on DOMContentLoaded. Extension entry: content.js
// calls HpChart.attach() directly with the fetched history.

(function (root) {
  "use strict";

  // Mirror: scraper/web.py::_PT_MONTHS (unused now that geometry is
  // client-side, but kept here so the date format matches the previous
  // server-rendered convention exactly).
  const PT_MONTHS = [
    "jan", "fev", "mar", "abr", "mai", "jun",
    "jul", "ago", "set", "out", "nov", "dez"
  ];

  const RANGES = [
    { id: "1w", label: "1S", days: 7 },
    { id: "1m", label: "1M", days: 30 },
    { id: "1y", label: "1A", days: 365 },
    { id: "all", label: "Tudo", days: null }
  ];

  const DEFAULT_RANGE = "1m";

  function formatPtEur(value) {
    return Number(value).toFixed(2).replace(".", ",") + " €";
  }

  function formatPtDate(ts) {
    const dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) return "";
    return `${String(dt.getDate()).padStart(2, "0")} ${PT_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function filterByDays(history, days) {
    if (!days) return history.slice();
    const cutoff = Date.now() - days * 86400000;
    return history.filter((h) => {
      const t = new Date(h.observed_at).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
  }

  // Returns SVG geometry + per-point hover-marker data. Coordinates are
  // laid out by observation index (not by timestamp) so unevenly-spaced
  // observations still render as a clean polyline. null when fewer than
  // 2 observations remain.
  function buildData(history, opts) {
    const o = opts || {};
    const width = o.width || 720;
    const height = o.height || 220;
    const pts = history
      .filter((r) => r && r.price != null)
      .map((r) => ({ price: Number(r.price), observed_at: r.observed_at }))
      .filter((r) => Number.isFinite(r.price));
    if (pts.length < 2) return null;
    const prices = pts.map((p) => p.price);
    let minP = Math.min.apply(null, prices);
    let maxP = Math.max.apply(null, prices);
    if (minP === maxP) {
      // Flat line — pad the y-range so it doesn't collapse to zero.
      const pad = Math.max(minP * 0.05, 0.1);
      minP -= pad;
      maxP += pad;
    }
    const padX = 12, padY = 16;
    const plotW = width - 2 * padX;
    const plotH = height - 2 * padY;
    const n = pts.length - 1;
    const round1 = (v) => Math.round(v * 10) / 10;
    const round3 = (v) => Math.round(v * 1000) / 1000;
    const points = pts.map((r, i) => {
      const x = padX + (i / n) * plotW;
      const y = padY + (1 - (r.price - minP) / (maxP - minP)) * plotH;
      return {
        x: round1(x),
        y: round1(y),
        // CSS-positioned hover markers — `--hp-chart-x` / `--hp-chart-y`
        // on the marker element place the dot + tooltip + guideline.
        leftPct: round3((x / width) * 100),
        topPct: round3((y / height) * 100),
        priceLabel: formatPtEur(r.price),
        dateLabel: formatPtDate(r.observed_at)
      };
    });
    const linePath = points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
      .join(" ");
    const bottomY = round1(padY + plotH);
    const areaPath =
      `M ${points[0].x} ${bottomY} ` +
      points.map((p) => `L ${p.x} ${p.y}`).join(" ") +
      ` L ${points[points.length - 1].x} ${bottomY} Z`;
    return {
      width, height,
      linePath, areaPath, points,
      minPriceLabel: formatPtEur(minP),
      maxPriceLabel: formatPtEur(maxP),
      minY: bottomY,
      maxY: padY,
      labelXLeft: padX,
      labelXRight: width - padX
    };
  }

  function renderChart(history) {
    const chart = buildData(history);
    if (!chart) return `<p class="hp-chart-empty">Sem dados no intervalo.</p>`;
    const markers = chart.points.map((p) => `
      <div class="hp-chart-marker"
           style="--hp-chart-x: ${p.leftPct}%; --hp-chart-y: ${p.topPct}%;"
           title="${escapeHtml(p.dateLabel)}: ${escapeHtml(p.priceLabel)}">
        <span class="hp-chart-guide"></span>
        <span class="hp-chart-dot"></span>
        <span class="hp-chart-tooltip">
          <span class="hp-chart-tooltip-price">${escapeHtml(p.priceLabel)}</span>
          <span class="hp-chart-tooltip-date">${escapeHtml(p.dateLabel)}</span>
        </span>
      </div>
    `).join("");
    return `
      <div class="hp-chart" style="--hp-chart-n: ${chart.points.length};">
        <svg class="hp-chart-svg" viewBox="0 0 ${chart.width} ${chart.height}"
             preserveAspectRatio="none" aria-hidden="true">
          <line class="hp-chart-axis hp-chart-axis-faint"
                x1="${chart.labelXLeft}" x2="${chart.labelXRight}"
                y1="${chart.maxY}" y2="${chart.maxY}"
                vector-effect="non-scaling-stroke"/>
          <line class="hp-chart-axis"
                x1="${chart.labelXLeft}" x2="${chart.labelXRight}"
                y1="${chart.minY}" y2="${chart.minY}"
                vector-effect="non-scaling-stroke"/>
          <path class="hp-chart-area" d="${chart.areaPath}"/>
          <path class="hp-chart-line" d="${chart.linePath}"
                vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="hp-chart-axis-label hp-chart-axis-label-max">${escapeHtml(chart.maxPriceLabel)}</span>
        <span class="hp-chart-axis-label hp-chart-axis-label-min">${escapeHtml(chart.minPriceLabel)}</span>
        <div class="hp-chart-markers" role="img"
             aria-label="Histórico de preços, ${chart.points.length} observações.">
          ${markers}
        </div>
      </div>
    `;
  }

  function renderButtons(activeId) {
    return RANGES.map((r) => `
      <button type="button" class="hp-chart-btn${r.id === activeId ? " hp-chart-btn-active" : ""}" data-range="${r.id}">${r.label}</button>
    `).join("");
  }

  // `host` is a container that, after the call, has two children:
  // .hp-chart-buttons and .hp-chart-container. Click handlers are
  // installed on the buttons; the container's innerHTML is replaced
  // each time the active range changes.
  function attach(host, history, opts) {
    const o = opts || {};
    const activeRange = o.defaultRange || DEFAULT_RANGE;
    if (!host.querySelector(".hp-chart-buttons")) {
      host.innerHTML = `
        <div class="hp-chart-buttons">${renderButtons(activeRange)}</div>
        <div class="hp-chart-container"></div>
      `;
    }
    const buttons = host.querySelector(".hp-chart-buttons");
    const container = host.querySelector(".hp-chart-container");
    const draw = (rangeId) => {
      const range = RANGES.find((r) => r.id === rangeId) || RANGES[1];
      const filtered = filterByDays(history, range.days);
      container.innerHTML = renderChart(filtered);
      buttons.querySelectorAll(".hp-chart-btn").forEach((b) => {
        b.classList.toggle("hp-chart-btn-active", b.dataset.range === rangeId);
      });
    };
    buttons.addEventListener("click", (e) => {
      const btn = e.target.closest(".hp-chart-btn");
      if (!btn) return;
      draw(btn.dataset.range);
    });
    draw(activeRange);
  }

  // Auto-init for the web side: every `.hp-chart-host` that carries a
  // JSON history in `data-history` gets attached on DOMContentLoaded.
  // The extension calls attach() directly so it can pass its own
  // fetched payload.
  function boot(scope) {
    const hosts = (scope || document).querySelectorAll(".hp-chart-host:not([data-hp-chart-ready])");
    hosts.forEach((host) => {
      let history;
      try {
        history = JSON.parse(host.getAttribute("data-history") || "[]");
      } catch (e) {
        return;
      }
      host.setAttribute("data-hp-chart-ready", "1");
      attach(host, history);
    });
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => boot());
    } else {
      boot();
    }
  }

  root.HpChart = {
    RANGES,
    DEFAULT_RANGE,
    formatPtEur,
    formatPtDate,
    filterByDays,
    buildData,
    renderChart,
    renderButtons,
    attach,
    boot
  };
})(typeof window !== "undefined" ? window : globalThis);
