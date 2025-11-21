// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// 🔑 0x API 설정
//   - ZEROX_BASE_URL 이 없으면 기본으로 "이더리움 메인넷" 엔드포인트 사용
const ZEROX_BASE_URL =
  process.env.ZEROX_BASE_URL || "https://api.0x.org"; // ★ 중요: 메인넷
const ZEROX_API_KEY = process.env.ZEROX_API_KEY || "";

console.log("[config] ZEROX_BASE_URL =", ZEROX_BASE_URL);

const axios0x = axios.create({
  baseURL: ZEROX_BASE_URL,
  headers: ZEROX_API_KEY ? { "0x-api-key": ZEROX_API_KEY } : {},
});

// 헬스체크
app.get("/", (_req, res) => {
  res.send("G-DEX backend is running.");
});

// 공통 0x 호출 함수 (GET /swap/v1/quote)
async function call0xSwapQuote(params) {
  const qs = new URLSearchParams(params).toString();
  const url = `/swap/v1/quote?${qs}`;

  console.log("0x request:", ZEROX_BASE_URL + url);

  try {
    const { data } = await axios0x.get(url);
    return data;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    console.error("0x error", status, data || err.message);

    // 프런트에서 보기 좋게 메시지만 뽑아서 보내기
    let msg = "0x error";
    if (data && typeof data === "object") {
      if (data.message) msg = data.message;
      else msg = JSON.stringify(data);
    } else if (typeof data === "string") {
      msg = data;
    } else if (err.message) {
      msg = err.message;
    }

    const error = new Error(msg);
    error.status = status || 500;
    throw error;
  }
}

// ===== /quote =====
// 프런트 자동 계산용
app.post("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, slippagePercentage } = req.body;

    const params = {
      sellToken,
      buyToken,
      sellAmount,
    };
    if (slippagePercentage != null)
      params.slippagePercentage = String(slippagePercentage);

    const quote = await call0xSwapQuote(params);
    return res.json(quote);
  } catch (e) {
    console.error("[/quote] error", e);
    res.status(e.status || 500).json({ message: e.message });
  }
});

// ===== /swap =====
// 실제 지갑에 보낼 트랜잭션 생성용
app.post("/swap", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, taker, slippagePercentage } =
      req.body;

    const params = {
      sellToken,
      buyToken,
      sellAmount,
      taker, // 메타마스크 주소 (taker)
    };
    if (slippagePercentage != null)
      params.slippagePercentage = String(slippagePercentage);

    const quote = await call0xSwapQuote(params);

    // 메타마스크에 넘겨줄 필드만 추리기
    const { to, data, value, gas, gasPrice } = quote;
    if (!to || !data) {
      return res.status(500).json({
        message: "0x quote did not return tx fields (to/data).",
        raw: quote,
      });
    }

    return res.json({ to, data, value, gas, gasPrice });
  } catch (e) {
    console.error("[/swap] error", e);
    res.status(e.status || 500).json({ message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`G-DEX backend listening on port ${PORT}`);
});
