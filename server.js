// server.js — G-DEX 0x AllowanceHolder(v2) backend

const express = require("express");
const cors = require("cors");

// Node 18 이상이면 전역 fetch 가 있지만, 안전하게 node-fetch fallback 추가
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY; // Render 환경변수에 설정한 값
const ZEROX_BASE = "https://api.0x.org";

// 공통 0x 호출 helper (AllowanceHolder v2)
async function call0xSwap(endpoint, params) {
  const url = new URL(`${ZEROX_BASE}/swap/allowance-holder/${endpoint}`);

  // 쿼리 스트링 구성
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const headers = {
    accept: "application/json",
    "0x-version": "v2",
  };
  if (ZEROX_API_KEY) headers["0x-api-key"] = ZEROX_API_KEY;

  console.log("0x request:", url.toString());

  const res = await fetchFn(url.toString(), { headers });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    console.error(`0x error ${res.status}`, data);
    const msg =
      (data && (data.message || data.reason)) ||
      "no Route matched with those values";
    // 프런트에 넘길 간단한 에러 형태
    const payload = { message: msg };
    const err = new Error(msg);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return data;
}

// 헬스 체크용
app.get("/", (_req, res) => {
  res.send("G-DEX backend is running.");
});

/**
 * /quote
 *  - 프런트의 “자동계산(미리보기)” 용
 *  - 0x AllowanceHolder /price 사용
 */
app.post("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount } = req.body;

    if (!sellToken || !buyToken || !sellAmount) {
      return res
        .status(400)
        .json({ message: "sellToken, buyToken, sellAmount are required." });
    }

    const params = {
      chainId: 1, // Ethereum mainnet
      sellToken,
      buyToken,
      sellAmount,
      // slippage는 가격 미리보기에서는 굳이 보낼 필요 없음 (기본값 사용)
    };

    const price = await call0xSwap("price", params);
    res.json(price);
  } catch (err) {
    console.error("[/quote] error", err);
    res
      .status(err.status || 500)
      .json(err.payload || { message: err.message || "Internal error" });
  }
});

/**
 * /swap
 *  - 실제 스왑 실행용
 *  - 0x AllowanceHolder /quote 사용 (firm quote)
 */
app.post("/swap", async (req, res) => {
  try {
    const {
      sellToken,
      buyToken,
      sellAmount,
      taker, // 사용자의 지갑 주소
      slippagePercentage, // 프런트에서 넘어온 슬리피지 (예: 0.02)
    } = req.body;

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({
        message: "sellToken, buyToken, sellAmount, taker are required.",
      });
    }

    // 2% → 200 bps 로 변환 (1% = 100 bps)
    let slippageBps;
    if (typeof slippagePercentage === "number" && !isNaN(slippagePercentage)) {
      slippageBps = Math.round(slippagePercentage * 10000);
    }

    const params = {
      chainId: 1,
      sellToken,
      buyToken,
      sellAmount,
      taker,
      ...(slippageBps ? { slippageBps } : {}),
    };

    const quote = await call0xSwap("quote", params);

    // MetaMask에 넘길 트랜잭션 필드만 프런트로 리턴
    const tx = {
      to: quote.to,
      data: quote.data,
      value: quote.value, // 없으면 undefined 그대로 두면 됨
      gas: quote.gas,
      gasPrice: quote.gasPrice,
    };

    res.json(tx);
  } catch (err) {
    console.error("[/swap] error", err);
    res
      .status(err.status || 500)
      .json(err.payload || { message: err.message || "Internal error" });
  }
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`G-DEX backend listening on port ${PORT}`);
});
