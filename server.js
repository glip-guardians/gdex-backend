// server.js — G-DEX backend (0x v2 allowance-holder) + (optional) RPC gas estimation

const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

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
  res.header("Access-Control-Allow-Headers", "Content-Type, 0x-api-key");

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

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "0x-api-key": ZEROX_API_KEY || "",
      "0x-version": "v2",
    },
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

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
  const chainId = body.chainId || 1; // mainnet default
  const { sellToken, buyToken, sellAmount, taker } = body;

  // slippagePercentage: 프런트는 0.02(=2%) 형태로 전달
  const slip = typeof body.slippagePercentage === "number" ? body.slippagePercentage : 0.02;
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
  const res = await fetch(RPC_URL, {
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
  const buffered = gas + (gas / 5n);
  return toHex(buffered);
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

    // ====== base tx (metamask용) ======
    // NOTE: 프런트가 decimal-string value를 hex로 변환하므로 value는 string 유지
    const tx = {
      to: rawTx.to,
      data: rawTx.data,
      value: "0",
    };

    // ETH sell이면 value는 sellAmount
    if (normalizedSell === ETH_SENTINEL) {
      tx.value = String(sellAmount);
    } else {
      // ERC20 sell은 보통 value=0
      tx.value = rawTx.value != null ? String(rawTx.value) : "0";
    }

    // ✅ (중요) 가능하면 gas / EIP-1559 fee까지 포함해서 프런트로 전달
    // 프런트가 이를 txParams에 넣어주면 실패율이 확 내려감
    // 0x가 gas를 줄 때도 있고, 없을 수도 있음 → 없으면 RPC로 estimate
    if (rawTx.gas != null) tx.gas = String(rawTx.gas);

    // RPC가 있으면 estimateGas + fee 추천
    if (RPC_URL) {
      // estimateGas를 하려면 from 필요 (taker)
      const estTx = {
        from: taker,
        to: tx.to,
        data: tx.data,
        value: tx.value === "0" ? "0x0" : toHex(BigInt(tx.value)),
      };

      try {
        const gasHex = await estimateGasWithBuffer(estTx);
        tx.gas = gasHex; // ✅ hex로 내려줌(메타마스크 호환)
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

app.listen(PORT, () => console.log(`G-DEX backend listening on port ${PORT}`));
