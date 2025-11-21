// server.js  — G-DEX backend (0x v2 allowance-holder API, single-unit-conversion)

// Node 18+ 에서는 fetch 가 글로벌로 존재합니다.
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const allowedOrigins = [
  "https://gdex-app.com",
  "https://www.gdex-app.com",
  "https://glip-guardians.github.io"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, 0x-api-key");
  res.header("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
const ZEROX_BASE = "https://api.0x.org";

if (!ZEROX_API_KEY) {
  console.warn("[WARN] ZEROX_API_KEY is not set in environment variables.");
}

/* --------------------------------------------------------
 * 공통: 0x 호출 헬퍼
 *  - 백엔드는 단위 변환을 하지 않고, 프런트에서 넘겨준
 *    값(이미 wei)을 그대로 0x에 전달만 한다.
 * ------------------------------------------------------*/
async function call0x(url) {
  console.log("[0x request]:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "0x-api-key": ZEROX_API_KEY,
      "0x-version": "v2", // allowance-holder v2 요구 헤더
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

/* --------------------------------------------------------
 * 헬퍼: 기본 쿼리 파라미터 구성
 *  - sellAmount 는 프런트에서 이미 10^decimals 로
 *    스케일링된 "wei 문자열" 이라고 가정한다.
 *  - 여기서는 절대 추가 변환을 하지 않는다.
 * ------------------------------------------------------*/
function buildParams(body) {
  const chainId = body.chainId || 1; // Ethereum 메인넷
  const { sellToken, buyToken, sellAmount, taker, slippagePercentage } = body;

  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: String(sellAmount), // 방어적으로 문자열로 캐스팅
  });

  if (taker) {
    params.set("taker", taker);
  }

  // slippagePercentage(예: 0.02) → slippageBps(예: 200)
  const slip =
    typeof slippagePercentage === "number" ? slippagePercentage : 0.02;
  const slippageBps = Math.round(slip * 10000);
  params.set("slippageBps", String(slippageBps));

  return params;
}

/* ==========================  라우트  ========================== */

// 헬스체크
app.get("/", (req, res) => {
  res.send("G-DEX backend is running.");
});

// 가격 미리보기 /quote (Swap 입력 시 자동계산)
app.post("/quote", async (req, res) => {
  try {
    const params = buildParams(req.body);

    // allowance-holder price 엔드포인트
    const url = `${ZEROX_BASE}/swap/allowance-holder/price?${params.toString()}`;
    const priceData = await call0x(url);

    // 프런트에서 buyAmount, price 등 바로 사용 가능
    res.json(priceData);
  } catch (err) {
    console.error("[/quote] error", err.status, err.details || err.message);
    res.status(err.status || 500).json({
      message: err.message || "Quote failed",
      details: err.details || null,
    });
  }
});

// 실제 스왑 /swap (Swap 버튼 클릭 시)
app.post("/swap", async (req, res) => {
  try {
    const params = buildParams(req.body);
    params.set("intentOnFilling", "true");

    // allowance-holder quote 엔드포인트 (tx 생성)
    const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
    const quoteData = await call0x(url);

    // 0x v2 응답: transaction 또는 tx 안에 트랜잭션 세부 정보가 있음
    const rawTx =
      quoteData.transaction ||
      quoteData.tx ||
      {
        to: quoteData.to,
        data: quoteData.data,
        value: quoteData.value,
        gas: quoteData.gas,
        gasPrice: quoteData.gasPrice,
      };

// ETH sentinel 주소 (프론트에서 쓰는 것과 동일해야 함)
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

// ...

// /swap 라우트 안
let valueToUse = rawTx.value ?? quoteData.value ?? "0";

// sellToken 이 ETH 일 때는 0x 가 준 value 를 믿지 않고,
// 프런트에서 넘어온 sellAmount(wei)를 그대로 value 로 사용
if ((req.body.sellToken || "").toLowerCase() === ETH_SENTINEL.toLowerCase()) {
  valueToUse = req.body.sellAmount;
}

const tx = {
  to: rawTx.to,
  data: rawTx.data,
  value: valueToUse,
  gas: rawTx.gas ?? quoteData.gas ?? undefined,
  gasPrice: rawTx.gasPrice ?? quoteData.gasPrice ?? undefined,
};


    if (!tx.to || !tx.data) {
      console.error("[/swap] missing tx fields in 0x response", quoteData);
      return res.status(500).json({
        message: "0x quote did not return tx fields",
        raw: quoteData,
      });
    }

    // 프런트: const tx = swapRes.tx; 로 사용
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


