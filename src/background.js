const RETAILERS = {
  continente: {
    addToCartUrl: "https://www.continente.pt/on/demandware.store/Sites-continente-Site/default/Cart-AddProduct",
    needsCsrf: false,
    buildBody: ({ sku, quantity }) =>
      `pid=${encodeURIComponent(sku)}&quantity=${quantity}&isCart=0&options=%5B%5D`,
  },
  auchan: {
    addToCartUrl: "https://www.auchan.pt/on/demandware.store/Sites-AuchanPT-Site/pt_PT/Cart-AddProduct",
    needsCsrf: true,
    buildBody: ({ sku, quantity, csrf }) =>
      `quantity=${quantity}&pid=${encodeURIComponent(sku)}&options=%5B%5D&pview=pdp&variant=&purchasedByUnit=true&purchasedByUnitMeasure=false&isUnitSwitched=false&csrf_token=${encodeURIComponent(csrf)}`,
  },
  pingodoce: {
    addToCartUrl: "https://www.pingodoce.pt/on/demandware.store/Sites-pingo-doce-Site/default/Cart-AddProduct",
    needsCsrf: false,
    buildBody: ({ sku, quantity }) =>
      `pid=${encodeURIComponent(sku)}&quantity=${quantity}&preparationMode=`,
  },
};

async function fetchCsrfToken(productUrl) {
  const res = await fetch(productUrl, { credentials: "include" });
  if (!res.ok) throw new Error(`csrf fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/name="csrf_token"[^>]*\bvalue="([^"]+)"/);
  if (!m) throw new Error("csrf token not found in page");
  return m[1];
}

async function addToCart({ retailer, sku, productUrl, quantity = 1 }) {
  const cfg = RETAILERS[retailer];
  if (!cfg) return { ok: false, reason: "unknown_retailer" };

  let csrf;
  if (cfg.needsCsrf) {
    if (!productUrl) return { ok: false, reason: "missing_product_url" };
    try {
      csrf = await fetchCsrfToken(productUrl);
    } catch (err) {
      return { ok: false, reason: "csrf_failed", message: String(err.message || err) };
    }
  }

  let res;
  try {
    res = await fetch(cfg.addToCartUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
      },
      body: cfg.buildBody({ sku, quantity, csrf }),
    });
  } catch (err) {
    return { ok: false, reason: "network", message: String(err.message || err) };
  }

  if (!res.ok) return { ok: false, reason: "http", status: res.status };

  const data = await res.json().catch(() => null);
  if (data && data.error) {
    if (data.showPostalCode) return { ok: false, reason: "postal_code", retailer };
    return { ok: false, reason: "remote_error", message: data.message || "" };
  }

  return { ok: true, retailer, sku };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "hp:addToCart") return false;
  addToCart(msg)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, reason: "exception", message: String(err.message || err) })
    );
  return true;
});
