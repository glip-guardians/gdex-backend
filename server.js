// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

// Render 에서 PORT 환경변수 넣어둔 값, 없으면 8080
const PORT = process.env.PORT || 8080;
// Render > Environment 에 넣어둔 0x API 키
const API_KEY = process.env.ZEROX_API_KEY;

const ZEROX_BASE = "https://api.0x.org";

app.use(cors());
app.use(express.json());

// 헬퍼: 0x 헤더
function zeroXHeaders() {
  const h = {};
  if (API_KEY) h["0x-api-key"] = API_KEY;
  return h;
}

// 헬퍼: 슬리피지(0.02) → bps("200")
function pctToBps(slip) {
  if (slip == null || isNaN(slip)) return "200";
  const bps = Math.round(Number(slip) * 10000); // 0.02 -> 200
  return String(Math.max(1, bps));
}

// 헬스 체크
app.get("/", (req, res) => {
  res.send("G-DEX backend is running.");
});

/**
 * /quote  : 가격 미리보기 용 (프론트 자동계산)
 * 0x 엔드포인트: /swap/allowance-holder/price
 */
app.post("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, slippagePercentage } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount) {
      return res
        .status(400)
        .json({ message: "sellToken, buyToken, sellAmount are required" });
    }

    const params = new URLSearchParams({
      chainId: "1",
      sellToken,
      buyToken,
      sellAmount,
      slippageBps: pctToBps(slippagePercentage),
    });

    const url = `${ZEROX_BASE}/swap/allowance-holder/price?${params.toString()}`;
    console.log("0x request [price]:", url);

    const resp = await axios.get(url, { headers: zeroXHeaders() });
    console.log("0x price status", resp.status);

    // 👉 가격 관련 데이터 그대로 프런트에 전달
    return res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const payload = err.response?.data || { message: err.message || "0x quote error" };
    console.error("[/quote] error", status, payload);
    return res.status(status).json(payload);
  }
});

/**
 * /swap : 실제 스왑 트랜잭션 생성
 * 0x 엔드포인트: /swap/allowance-holder/quote
 */
app.post("/swap", async (req, res) => {
  try {
    const {
      sellToken,
      buyToken,
      sellAmount,
      taker, // 지갑 주소 (프런트에서 userAddress)
      slippagePercentage,
    } = req.body || {};

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res.status(400).json({
        message: "sellToken, buyToken, sellAmount, taker are required",
      });
    }

    const params = new URLSearchParams({
      chainId: "1",
      sellToken,
      buyToken,
      sellAmount,
      taker,
      slippageBps: pctToBps(slippagePercentage),
      intentOnFilling: "true",
    });

    const url = `${ZEROX_BASE}/swap/allowance-holder/quote?${params.toString()}`;
    console.log("0x request [swap]:", url);

    const resp = await axios.get(url, { headers: zeroXHeaders() });
    console.log("0x swap status", resp.status);
    console.log("[/swap raw 0x data]", Object.keys(resp.data));

    // 🔥 핵심: 0x가 준 응답을 그대로 프런트에 전달
    // (여기에 to / data / value / gas / gasPrice 가 포함되어 있음)
    return res.json(resp.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const payload = err.response?.data || { message: err.message || "0x swap error" };
    console.error("[/swap] error", status, payload);
    return res.status(status).json(payload);
  }
});

app.listen(PORT, () => {
  console.log(`G-DEX backend listening on port ${PORT}`);
});
