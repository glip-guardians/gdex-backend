// server.js  — G-DEX backend (0x Swap API v2, allowance-holder)

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// 환경 변수
const PORT = process.env.PORT || 8080;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;

// 0x Swap API (allowance-holder) v2 설정
const SWAP_BASE = "https://api.0x.org/swap/allowance-holder";
const CHAIN_ID = 1;

// G-DEX용 taker(스왑을 실제로 실행하는 주소) – 지금은 그냥 프론트에서 보내주는 값 사용
// 필요시 고정 주소로 바꿀 수 있음
// const DEFAULT_TAKER = "0xYOUR_TAKER_ADDRESS";

// 공통 헤더 (0x-version 꼭 들어가야 함)
function build0xHeaders() {
  if (!ZEROX_API_KEY) {
    console.warn("[WARN] ZEROX_API_KEY is not set");
  }
  return {
    "Accept": "application/json",
    "0x-api-key": ZEROX_API_KEY || "",
    "0x-version": "v2",
  };
}

// slippage (% → bps)
function pctToBps(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 200; // default 2%
  return Math.round(n * 100);
}

// 0x로 price / quote 호출
async function call0x(path, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${SWAP_BASE}/${path}?${qs}`;
  console.log("0x request:", url);

  const res = await axios.get(url, { headers: build0xHeaders() });
  console.log("0x response status:", res.status);
  return res.data;
}

/**
 * POST /quote
 * 프론트에서 자동계산(미리보기)용으로 사용
 * body: { sellToken, buyToken, sellAmount, slippagePercentage }
 */
app.post("/quote", async (req, res) => {
  try {
    const {
      sellToken,
      buyToken,
      sellAmount,
      slippagePercentage,
      taker,
    } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount) {
      return res.status(400).json({ message: "Missing params" });
    }

    const slippageBps = pctToBps(slippagePercentage);
    const params = {
      chainId: String(CHAIN_ID),
      sellToken,
      buyToken,
      sellAmount,
      taker: taker || undefined,        // taker가 있으면 전달
      slippageBps: String(slippageBps), // v2에서는 slippageBps
    };

    const data = await call0x("price", params); // allowance-holder/price
    return res.json(data);
  } catch (err) {
    console.error("[/quote] error", err.response?.data || err.message);
    const status = err.response?.status || 500;
    return res.status(status).json(
      err.response?.data || {
        message: err.message || "Quote error",
      }
    );
  }
});

/**
 * POST /swap
 * 실제 스왑 실행용. 0x firm quote를 받아서
 * 프론트가 메타마스크에 그대로 보내게끔 tx 필드만 추려서 반환
 *
 * body: { sellToken, buyToken, sellAmount, taker, slippagePercentage }
 */
app.post("/swap", async (req, res) => {
  try {
    const {
      sellToken,
      buyToken,
      sellAmount,
      taker,
      slippagePercentage,
    } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({ message: "Missing params" });
    }

    const slippageBps = pctToBps(slippagePercentage);
    const params = {
      chainId: String(CHAIN_ID),
      sellToken,
      buyToken,
      sellAmount,
      buyTokenPercentageFee: "0", // 수수료 안 붙이는 기본값
      taker,
      slippageBps: String(slippageBps),
      intentOnFilling: "true",
    };

    // allowance-holder/quote → firm quote + transaction data
    const quote = await call0x("quote", params);

    // v2 응답 구조에서 트랜잭션 필드 추출
    // (transaction 오브젝트가 있으면 그 안에서, 없으면 루트에서)
    const tx = quote.transaction || quote;

    if (!tx || !tx.to || !tx.data) {
      console.error("[/swap] invalid tx object from 0x:", quote);
      return res.status(500).json({
        message: "0x quote did not include transaction fields",
      });
    }

    const txOut = {
      to: tx.to,
      data: tx.data,
      value: tx.value || "0x0",
    };

    // gas, gasPrice가 있으면 그대로 같이 넘겨줌 (선택 사항)
    if (tx.gas) txOut.gas = tx.gas;
    if (tx.gasPrice) txOut.gasPrice = tx.gasPrice;

    console.log("[/swap] txOut", txOut);
    return res.json(txOut);
  } catch (err) {
    console.error("[/swap] error", err.response?.data || err.message);
    const status = err.response?.status || 500;
    return res.status(status).json(
      err.response?.data || {
        message: err.message || "Swap error",
      }
    );
  }
});

// 헬스체크용
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "G-DEX backend", version: "0x-v2" });
});

app.listen(PORT, () => {
  console.log(`G-DEX backend listening on port ${PORT}`);
});
