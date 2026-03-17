// server.js — G-DEX backend (0x v2 allowance-holder) + (optional) RPC gas estimation
// + Sushi pools proxy (GraphQL)
//
// ✅ Hardening changes:
// - Safe fetch() fallback (Node <18 대비)
// - /swap tx fields: gas/value 가능한 한 HEX로 통일
// - app.listen moved to bottom
// - CORS headers slightly expanded

const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =========================
   fetch polyfill (safe)
   ========================= */
const fetchFn =
  typeof global.fetch === "function"
    ? global.fetch.bind(global)
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/* =========================
   CORS (화이트리스트만 허용)
   ========================= */
const allowedOrigins = new Set([
  "https://gdex-app.com",
  "https://www.gdex-app.com",
  "https://glip-guardians.github.io",
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  // ✅ 프런트/프록시에서 헤더가 추가될 수 있어 여유 있게 허용
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, 0x-api-key, Authorization, Accept"
  );

  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* =========================
   ENV & CONST
   ========================= */
const PORT = process.env.PORT || 8080;

const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
const ZEROX_BASE = "https://api.0x.org";

// ✅ 선택: RPC 넣으면 실패율 크게 내려감(estimateGas/fee 계산)
const RPC_URL = process.env.RPC_URL || ""; // 예: https://eth-mainnet.g.alchemy.com/v2/xxx

// 수수료(인티그레이터 fee)
const FEE_RECIPIENT = "0x932bf0a8746c041c00131640123fa6c847835d6f";
const FEE_PERCENTAGE = 0.001; // 0.1%

const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

if (!ZEROX_API_KEY) console.warn("[WARN] ZEROX_API_KEY is not set.");
if (!RPC_URL) console.warn("[WARN] RPC_URL is not set. Gas estimation will be skipped.");

/* =========================
   Helpers
   ========================= */
function assertSupportedChain(chainId) {
  const id = Number(chainId || 1);

  // 현재 G-DEX 구조가 이더리움 메인넷만 쓰는 상태라면 이렇게 가장 안전
  if (id !== 1) {
    const err = new Error(`Unsupported chainId: ${id}. Only Ethereum Mainnet is supported.`);
    err.status = 400;
    err.details = { code: "UNSUPPORTED_CHAIN", chainId: id };
    throw err;
  }

  return id;
}
function isHexAddress(a) {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function mustBeUintString(x) {
  // 0x에 넘길 sellAmount는 "정수 문자열(wei)" 이어야 안정적
  return typeof x === "string" && /^[0-9]+$/.test(x);
}

function clampNumber(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

async function call0x(url) {
  console.log("[0x request]:", url);

  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "0x-api-key": ZEROX_API_KEY || "",
      "0x-version": "v2",
    },
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error("[0x error]", res.status, data);
    const err = new Error(data.message || `0x request failed: ${res.status}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

function buildParams(body) {
  const chainId = assertSupportedChain(body.chainId || 1);
  const { sellToken, buyToken, sellAmount, taker } = body;

  // slippagePercentage: 프런트는 0.02(=2%) 형태로 전달 가정
  const slip =
    typeof body.slippagePercentage === "number" ? body.slippagePercentage : 0.02;
  const safeSlip = clampNumber(slip, 0, 0.2); // 0% ~ 20% 제한
  const slippageBps = Math.round(safeSlip * 10000);

  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount),
    slippageBps: String(slippageBps),
  });

  if (taker) params.set("taker", taker);

  // fee: price/quote 모두 동일하게 붙여야 preview/체결 불일치가 없음
  if (FEE_RECIPIENT && FEE_PERCENTAGE > 0) {
    params.set("feeRecipient", FEE_RECIPIENT);
    params.set("buyTokenPercentageFee", String(FEE_PERCENTAGE));
  }

  return params;
}

/* =========================
   Optional JSON-RPC helpers
   ========================= */
let rpcId = 1;
async function rpc(method, params) {
  if (!RPC_URL) throw new Error("RPC_URL not set");
  const res = await fetchFn(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function toHex(nBigInt) {
  return "0x" + nBigInt.toString(16);
}

function bnFromHex(hex) {
  return BigInt(hex);
}

/* EIP-1559 fee 추천값(간단 버전)
   - latest baseFee + tip(eth_maxPriorityFeePerGas) 기반
*/
async function suggestEip1559Fees() {
  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  const baseFee = block && block.baseFeePerGas ? bnFromHex(block.baseFeePerGas) : 0n;

  let tip = 1500000000n; // 1.5 gwei fallback
  try {
    const tipHex = await rpc("eth_maxPriorityFeePerGas", []);
    tip = bnFromHex(tipHex);
  } catch {}

  // maxFee = baseFee*2 + tip (보수적)
  const maxFee = baseFee * 2n + tip;
  return {
    maxPriorityFeePerGas: toHex(tip),
    maxFeePerGas: toHex(maxFee),
  };
}

async function estimateGasWithBuffer(tx) {
  const gasHex = await rpc("eth_estimateGas", [tx]);
  const gas = bnFromHex(gasHex);
  // 20% 버퍼
  const buffered = gas + gas / 5n;
  return toHex(buffered);
}

// ✅ decimal-string -> hex (메타마스크/eth_sendTransaction 호환)
function decStringToHex(decStr) {
  try {
    const n = BigInt(String(decStr || "0"));
    return toHex(n);
  } catch {
    return "0x0";
  }
}

// ✅ gas는 hex로 내려주는 편이 안전
function normalizeGasField(g) {
  if (g == null) return null;
  const s = String(g);
  if (s.startsWith("0x")) return s;
  // decimal -> hex
  if (/^[0-9]+$/.test(s)) return toHex(BigInt(s));
  return null;
}

/* =========================
   Routes
   ========================= */
app.get("/", (req, res) => res.send("G-DEX backend is running."));

/* /quote — price preview */
app.post("/quote", async (req, res) => {
  try {
    const b = req.body || {};
    const { sellToken, buyToken, sellAmount } = b;

    if (!sellToken || !buyToken || sellAmount == null) {
      return res.status(400).json({ message: "Missing sellToken/buyToken/sellAmount" });
    }
    if (sellToken !== ETH_SENTINEL && sellToken !== "ETH" && !isHexAddress(sellToken)) {
      return res.status(400).json({ message: "Invalid sellToken address" });
    }
    if (buyToken !== ETH_SENTINEL && buyToken !== "ETH" && !isHexAddress(buyToken)) {
      return res.status(400).json({ message: "Invalid buyToken address" });
    }
    if (!mustBeUintString(String(sellAmount))) {
      return res.status(400).json({ message: "sellAmount must be an integer string (wei)" });
    }

    const params = buildParams({
      ...b,
      sellToken: sellToken === "ETH" ? ETH_SENTINEL : sellToken,
      buyToken: buyToken === "ETH" ? ETH_SENTINEL : buyToken,
      sellAmount: String(sellAmount),
    });

    const url = `${ZEROX_BASE}/swap/allowance-holder/price?${params.toString()}`;
    const priceData = await call0x(url);

    res.json(priceData);
  } catch (err) {
    console.error("[/quote] error", err.status, err.details || err.message);
    res.status(err.status || 500).json({
      message: err.message || "Quote failed",
      details: err.details || null,
    });
  }
});

/* /swap — build tx */
app.post("/swap", async (req, res) => {
  try {
    const b = req.body || {};
    const { sellToken, buyToken, sellAmount, taker } = b;

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({ message: "Missing sellToken/buyToken/sellAmount/taker" });
    }
    if (!isHexAddress(taker)) {
      return res.status(400).json({ message: "Invalid taker address" });
    }
    if (!mustBeUintString(String(sellAmount))) {
      return res.status(400).json({ message: "sellAmount must be an integer string (wei)" });
    }

    const normalizedSell = sellToken === "ETH" ? ETH_SENTINEL : sellToken;
    const normalizedBuy  = buyToken === "ETH" ? ETH_SENTINEL : buyToken;

    const params = buildParams({
      ...b,
      sellToken: normalizedSell,
      buyToken: normalizedBuy,
      sellAmount: String(sellAmount),
    });

    // ✅ intentOnFilling=true 는 allowance-holder에서 권장
    params.set("intentOnFilling", "true");

    const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
    const quoteData = await call0x(url);

    const rawTx = quoteData.transaction || {};
    if (!rawTx.to || !rawTx.data) {
      return res.status(500).json({ message: "0x quote did not return tx fields", raw: quoteData });
    }

    // ====== base tx (메타마스크용) ======
    // ✅ value/gas는 가능하면 HEX로 통일해서 내림
    const tx = {
      to: rawTx.to,
      data: rawTx.data,
      value: "0x0",
    };

    // ETH sell이면 value는 sellAmount
    if (normalizedSell === ETH_SENTINEL) {
      tx.value = decStringToHex(String(sellAmount));
    } else {
      // ERC20 sell은 보통 value=0
      tx.value = rawTx.value != null
        ? (String(rawTx.value).startsWith("0x") ? String(rawTx.value) : decStringToHex(String(rawTx.value)))
        : "0x0";
    }

    // 0x가 gas를 줄 때도 있고 없을 수도 → 있으면 normalize
    const maybeGas = normalizeGasField(rawTx.gas);
    if (maybeGas) tx.gas = maybeGas;

    // RPC가 있으면 estimateGas + fee 추천
    if (RPC_URL) {
      const estTx = {
        from: taker,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      };

      try {
        const gasHex = await estimateGasWithBuffer(estTx);
        tx.gas = gasHex; // ✅ hex
      } catch (e) {
        console.warn("[swap] estimateGas failed, fallback to 0x gas if any", e.message || e);
      }

      try {
        const fees = await suggestEip1559Fees();
        tx.maxFeePerGas = fees.maxFeePerGas;
        tx.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      } catch (e) {
        console.warn("[swap] fee suggestion failed", e.message || e);
      }
    }

    console.log("[/swap] tx -> frontend:", tx);
    res.json({ tx });
  } catch (err) {
    console.error("[/swap] error", err.status, err.details || err.message);
    res.status(err.status || 500).json({
      message: err.message || "Swap failed",
      details: err.details || null,
    });
  }
});

// ==============================
// Sushi Pools Proxy API (GraphQL)
// GET /sushi/pools?chain=ethereum&limit=5
// ==============================
const SUSHI_SUBGRAPH_URL = process.env.SUSHI_SUBGRAPH_URL;

// 간단 캐시(서버 메모리) — 60초
const __sushiCache = new Map(); // key: chain|limit  value: { ts, data }
const SUSHI_CACHE_TTL_MS = 60 * 1000;

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function formatUsdCompact(v) {
  const n = safeNum(v, 0);

  // ✅ 0 이하거나 너무 작으면 0.00 대신 "—"로
  if (n <= 0) return "$—";
  if (n < 0.01) return "<$0.01";

  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}m`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}



/**
 * ✅ sushiswap/exchange(=v2 스타일) 기준:
 * pairs에는 reserveUSD/volumeUSD는 있지만 swapFee는 없음.
 */
async function fetchSushiPoolsFromGraphql({ chain = "ethereum", limit = 5 }) {
  if (!SUSHI_SUBGRAPH_URL) throw new Error("SUSHI_SUBGRAPH_URL env is missing");

  // NOTE: chain 파라미터는 지금은 URL만 단일 사용(ethereum 고정)로 두되,
  // 추후 멀티체인 지원 시 여기서 URL을 체인별로 분기하세요.
  const first = Math.max(1, Math.min(20, Number(limit) || 5));

  const query = `
    query Pairs($first:Int!) {
      pairs(first: $first, orderBy: createdAtTimestamp, orderDirection: desc) {
        id
        createdAtTimestamp
        token0 { symbol }
        token1 { symbol }
        reserveUSD
        volumeUSD
      }
    }
  `;

  const body = JSON.stringify({ query, variables: { first } });

  const r = await fetchFn(SUSHI_SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`GraphQL HTTP ${r.status}: ${text.slice(0, 200)}`);

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("GraphQL returned non-JSON response");
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(" | ")}`);
  }

  const arr = Array.isArray(json.data?.pairs) ? json.data.pairs : [];
  if (!arr.length) {
    throw new Error("Sushi subgraph schema mismatch or empty response");
  }

  const items = arr.map((p) => {
    const t0 = p?.token0?.symbol || "?";
    const t1 = p?.token1?.symbol || "?";
    const name = `${t0} / ${t1}`;

    const tvlUsd = safeNum(p.reserveUSD ?? 0, 0);
    const volUsd = safeNum(p.volumeUSD ?? 0, 0);

    // ✅ swapFee 필드가 없으므로 v2 기본 수수료(0.3%)를 고정 표시
    const feePct = 0.3;

    return {
      id: p.id,
      name,
      tvlUsd,
      tvlText: formatUsdCompact(tvlUsd),
      volumeUsd: volUsd,
      feePct,
      url: `https://www.sushi.com/ethereum/pool/${p.id}`,
    };
  });

  return items;
}

app.get("/sushi/pools", async (req, res) => {
  try {
    const chain = String(req.query.chain || "ethereum").toLowerCase();
    const limit = Math.max(1, Math.min(10, Number(req.query.limit || 5)));

    const cacheKey = `${chain}|${limit}`;
    const cached = __sushiCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.ts < SUSHI_CACHE_TTL_MS) {
      return res.json({ ok: true, chain, cached: true, items: cached.data });
    }

    const items = await fetchSushiPoolsFromGraphql({ chain, limit });
    __sushiCache.set(cacheKey, { ts: now, data: items });

    return res.json({ ok: true, chain, cached: false, items });
  } catch (e) {
    console.error("[/sushi/pools] error:", e?.message || e);

    // 프런트가 "—"로라도 안전하게 뜨도록 fallback 유지
    return res.status(200).json({
      ok: false,
      error: String(e?.message || e),
      items: [
        { id: "0x0", name: "WBTC / ETH", tvlUsd: 0, tvlText: "$—", feePct: 0.3, url: "https://www.sushi.com/ethereum/explore/pools" },
        { id: "0x0", name: "DAI / ETH",  tvlUsd: 0, tvlText: "$—", feePct: 0.3, url: "https://www.sushi.com/ethereum/explore/pools" },
        { id: "0x0", name: "USDC / ETH", tvlUsd: 0, tvlText: "$—", feePct: 0.3, url: "https://www.sushi.com/ethereum/explore/pools" },
        { id: "0x0", name: "SUSHI / ETH",tvlUsd: 0, tvlText: "$—", feePct: 0.3, url: "https://www.sushi.com/ethereum/explore/pools" },
        { id: "0x0", name: "LINK / ETH", tvlUsd: 0, tvlText: "$—", feePct: 0.3, url: "https://www.sushi.com/ethereum/explore/pools" },
      ],
    });
  }
});

/* =========================
   📰 Crypto News Section (NEW)
   - No extra packages required (Node 18+ fetch)
   - Caches titles (default 10 min)
   - Returns top 5 items for rolling UI
   ========================= */

const NEWS_SOURCES = [
  { name: "CoinDesk",      url: "https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "CryptoSlate",   url: "https://cryptoslate.com/feed/" },
  { name: "CryptoNews",    url: "https://cryptonews.com/news/feed/" },
  { name: "CryptoPotato",  url: "https://cryptopotato.com/feed/" },
];

// in-memory cache
let cryptoNewsCache = {
  updatedAt: 0,
  items: [], // [{ title, link, source }]
  error: null
};

const NEWS_MAX_ITEMS = 5;               // 프런트 롤링 표시 5줄
const NEWS_REFRESH_MS = 10 * 60 * 1000; // 10분마다 갱신 (원하면 5~15분으로 조절)

// 아주 가벼운 RSS 파서(제목/링크만): 라이브러리 없이 정규식 기반
function decodeXmlEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRss(xml, sourceName) {
  const items = [];
  if (!xml || typeof xml !== "string") return items;

  // <item> ... </item> 추출
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch  = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);

    const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : "";
    const link  = linkMatch  ? decodeXmlEntities(linkMatch[1])  : "";

    if (!title) continue;

    items.push({
      title,
      link: link || null,
      source: sourceName
    });

    if (items.length >= 10) break; // 소스별 상위 몇 개만
  }
  return items;
}

async function fetchOneRss(src) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000); // 8초 타임아웃
  try {
    const res = await fetchFn(src.url, {
      method: "GET",
      headers: {
        "User-Agent": "G-DEX-NewsFetcher/1.0",
        "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8"
      },
      signal: controller.signal
    });
    const text = await res.text();
    return parseRss(text, src.name);
  } finally {
    clearTimeout(t);
  }
}

async function refreshCryptoNews() {
  try {
    const results = await Promise.allSettled(NEWS_SOURCES.map(fetchOneRss));
    const merged = [];

    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value)) merged.push(...r.value);
    }

    // 중복 제거(제목 기준) + 정리
    const seen = new Set();
    const deduped = [];
    for (const it of merged) {
      const key = (it.title || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
      if (deduped.length >= NEWS_MAX_ITEMS) break;
    }

    cryptoNewsCache = {
      updatedAt: Date.now(),
      items: deduped,
      error: null
    };
  } catch (e) {
    cryptoNewsCache = {
      updatedAt: Date.now(),
      items: cryptoNewsCache.items || [],
      error: (e && e.message) ? e.message : String(e)
    };
  }
}

// 서버 시작 시 1회 갱신 + 주기 갱신
refreshCryptoNews().catch(()=>{});
setInterval(() => refreshCryptoNews().catch(()=>{}), NEWS_REFRESH_MS);

// ✅ 프런트에서 호출할 엔드포인트
// GET /api/crypto-news -> { updatedAt, items:[{title,link,source}], error? }
app.get("/api/crypto-news", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(cryptoNewsCache);
});
/* =========================
   📰 Crypto News Section End
   ========================= */

/* =========================
   Listen
   ========================= */
app.listen(PORT, () => console.log(`G-DEX backend listening on port ${PORT}`));









