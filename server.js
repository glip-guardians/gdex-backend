// server.js  — G-DEX backend proxy (0x Swap API)

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8080;
const ZEROX_BASE = "https://api.0x.org";

app.use(cors());
app.use(express.json());

// 간단한 헬스 체크 (브라우저로 접속 시 확인용)
app.get("/", (req, res) => {
  res.send("G-DEX backend is running.");
});

// 0x 호출 공통 함수
async function call0x(relativePath, params) {
  const url = new URL(relativePath, ZEROX_BASE);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  });

  const headers = { accept: "application/json" };
  if (process.env.ZEROX_API_KEY) {
    headers["0x-api-key"] = process.env.ZEROX_API_KEY;
  }

  const resp = await fetch(url.toString(), { headers });
  const text = await resp.text();

  if (!resp.ok) {
    console.error("0x error", resp.status, text);
    throw new Error(text || `0x error ${resp.status}`);
  }
  return JSON.parse(text);
}

/**
 * POST /quote
 *  프리뷰용 — 0x quote 를 그대로 반환 (buyAmount, price 등 포함)
 *  body: { sellToken, buyToken, sellAmount, slippagePercentage? }
 */
app.post("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, slippagePercentage } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount) {
      return res.status(400).json({
        error: "MISSING_PARAMS",
        message: "sellToken, buyToken and sellAmount are required."
      });
    }

    // unified 0x swap quote — 주소 형식 토큰 사용 (ETH → 0xEeee...)
    const quote = await call0x("/swap/quote", {
      sellToken,
      buyToken,
      sellAmount,
      ...(slippagePercentage ? { slippagePercentage } : {})
    });

    // 프런트에서 buyAmount, price 등 자유롭게 사용
    res.json(quote);
  } catch (err) {
    console.error("[/quote] error", err);
    res.status(500).send(err.message || "quote error");
  }
});

/**
 * POST /swap
 *  실제 스왑용 — MetaMask 에 바로 보낼 수 있는 트랜잭션 필드만 반환
 *  body: { sellToken, buyToken, sellAmount, taker, slippagePercentage? }
 */
app.post("/swap", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, taker, slippagePercentage } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({
        error: "MISSING_PARAMS",
        message: "sellToken, buyToken, sellAmount and taker are required."
      });
    }

    // 0x에서 quote + tx 데이터까지 한번에 받기
    const quote = await call0x("/swap/quote", {
      sellToken,
      buyToken,
      sellAmount,
      taker,
      intentOnFilling: "true",
      ...(slippagePercentage ? { slippagePercentage } : {})
    });

    // 프런트에서 필요한 필드만 정리해서 반환
    const tx = {
      to: quote.to,
      data: quote.data,
      value: quote.value ?? "0x0",
      gas: quote.gas,
      gasPrice: quote.gasPrice,
      allowanceTarget: quote.allowanceTarget,
      sellTokenAddress: quote.sellToken,
      buyTokenAddress: quote.buyToken,
      sellAmount: quote.sellAmount,
      buyAmount: quote.buyAmount,
    };

    if (!tx.to || !tx.data) {
      console.error("[/swap] missing to/data in 0x quote", quote);
      return res.status(500).json({
        error: "NO_TX_FIELDS",
        message: "0x quote did not include transaction data."
      });
    }

    res.json(tx);
  } catch (err) {
    console.error("[/swap] error", err);
    res.status(500).send(err.message || "swap error");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 G-DEX backend listening on port ${PORT}`);
});
