// server.js  — G-DEX backend (0x v2 allowance-holder API)

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
const ZEROX_BASE = "https://api.0x.org";

if (!ZEROX_API_KEY) {
  console.warn("[WARN] ZEROX_API_KEY is not set in environment variables.");
}

// 공통: 0x 요청 함수
async function call0x(url) {
  console.log("[0x request]:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "0x-api-key": ZEROX_API_KEY,
      "0x-version": "v2", // ★ 에러 메시지에서 요구했던 헤더
    },
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    console.error("[0x parse error]", e);
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

// 헬퍼: 기본 파라미터 구성
function buildParams(body) {
  const chainId = body.chainId || 1; // Ethereum 메인넷
  const { sellToken, buyToken, sellAmount, taker, slippagePercentage } = body;

  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount, // 이미 wei 기준 문자열로 들어온다고 가정
  });

  if (taker) {
    params.set("taker", taker);
  }

  // slippagePercentage (예: 0.02) → slippageBps (예: 200)
  const slip = typeof slippagePercentage === "number"
    ? slippagePercentage
    : 0.02;
  const slippageBps = Math.round(slip * 10000);
  params.set("slippageBps", String(slippageBps));

  return params;
}

// -----------------  라우트  -----------------

// 헬스체크용
app.get("/", (req, res) => {
  res.send("G-DEX backend is running.");
});

// 가격 미리보기 /quote  (Swap 입력시 자동계산용)
app.post("/quote", async (req, res) => {
  try {
    const params = buildParams(req.body);

    const url = `${ZEROX_BASE}/swap/allowance-holder/price?${params.toString()}`;
    const priceData = await call0x(url);

    // 프론트에서 바로 쓰도록 전체 응답을 그대로 전달
    res.json(priceData);
  } catch (err) {
    console.error("[/quote] error", err.status, err.details || err.message);
    res.status(err.status || 500).json({
      message: err.message || "Quote failed",
      details: err.details || null,
    });
  }
});

// 실제 스왑 /swap  (Swap 버튼 클릭시)
app.post("/swap", async (req, res) => {
  try {
    const params = buildParams(req.body);
    // intentOnFilling=true 추가
    params.set("intentOnFilling", "true");

    const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
    const quoteData = await call0x(url);

    // 0x v2 allowance-holder 응답에서는 tx 정보가 transaction 안에 들어있음
    const txSrc = quoteData.transaction || {};

    const tx = {
      to: txSrc.to,
      data: txSrc.data,
      value: txSrc.value || "0",
    };

    if (!tx.to || !tx.data) {
      console.error("[/swap] missing tx fields in 0x response", quoteData);
      return res.status(500).json({
        message: "0x quote did not return tx fields",
        raw: quoteData,
      });
    }

    // 프론트는 res.tx.to / res.tx.data / res.tx.value 를 사용
    res.json({ tx });
  } catch (err) {
    console.error("[/swap] error", err.status, err.details || err.message);
    res.status(err.status || 500).json({
      message: err.message || "Swap failed",
      details: err.details || null,
    });
  }
});


// 서버 시작
app.listen(PORT, () => {
  console.log(`G-DEX backend listening on port ${PORT}`);
});

