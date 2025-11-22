// server.js  — G-DEX backend (0x v2 allowance-holder API, single-unit-conversion + feeRecipient)

// Node 18+ 에서는 fetch 가 글로벌로 존재합니다.
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();

// ------------------------
// CORS 허용 도메인
// ------------------------
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

// ------------------------
// 환경변수 & 상수
// ------------------------
const PORT = process.env.PORT || 8080;
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
const ZEROX_BASE = "https://api.0x.org";

// ✅ 수수료(인티그레이터 fee) 설정
// - FEE_RECIPIENT: 수수료를 받을 지갑 주소
// - FEE_PERCENTAGE: buyToken 기준 퍼센트 (예: 0.001 = 0.1%, 0.01 = 1%)
const FEE_RECIPIENT = "0x932bf0a8746c041c00131640123fa6c847835d6f";
const FEE_PERCENTAGE = 0.001; // 0.1% 수수료 — 필요시 숫자만 변경

// 0x ETH sentinel
const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

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
 *  - ✅ 여기에서 feeRecipient / buyTokenPercentageFee 추가
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

  // ✅ 0x 수수료 파라미터 추가
  // - feeRecipient: 수수료를 받을 주소
  // - buyTokenPercentageFee: 수수료 비율 (소수, 예: 0.001 = 0.1%)
  //   price / quote 둘 다 동일하게 붙여야 미리보기/실제 체결이 일치
  if (FEE_RECIPIENT && FEE_PERCENTAGE > 0) {
    params.set("feeRecipient", FEE_RECIPIENT);
    params.set("buyTokenPercentageFee", String(FEE_PERCENTAGE));
  }

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

    // allowance-holder price 엔드포인트 (수수료 포함된 가격)
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

    // allowance-holder quote 엔드포인트 (tx 생성, 수수료 포함)
    const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
    const quoteData = await call0x(url);

    // 0x v2 응답: transaction 안에 트랜잭션 세부 정보
    const rawTx = quoteData.transaction || {};

    // ====== 우리가 보낼 tx 구성 ======
    // 1) to, data는 0x 것을 그대로 사용
    const tx = {
      to: rawTx.to,
      data: rawTx.data,
    };

    // 2) ETH를 파는 경우(sellToken = ETH sentinel)에는
    //    사용자가 입력한 sellAmount(wei)를 그대로 value 로 사용
    if (req.body.sellToken === ETH_SENTINEL) {
      tx.value = String(req.body.sellAmount); // 예: 0.0023 ETH → 2300000000000000
    } else {
      // ERC-20 → 어떤 토큰 스왑: 일반적으로 value = 0 이어야 함
      // 혹시 0x가 fee 등으로 value 를 요구하면 그대로 따라가고,
      // 둘 다 없으면 "0"
      tx.value = rawTx.value ?? quoteData.value ?? "0";
    }

    // ✅ gas / gasPrice 는 MetaMask 에게 맡김 (0x에서 온 값을 강제하지 않음)
    // 필요하면 아래를 다시 활성화
    // if (rawTx.gas != null)      tx.gas      = rawTx.gas;
    // if (rawTx.gasPrice != null) tx.gasPrice = rawTx.gasPrice;

    if (!tx.to || !tx.data) {
      console.error("[/swap] missing tx fields in 0x response", quoteData);
      return res.status(500).json({
        message: "0x quote did not return tx fields",
        raw: quoteData,
      });
    }

    console.log("[/swap] final tx sent to frontend:", tx);

    // 프런트: const tx = swapRes.tx || swapRes;
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

