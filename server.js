// server.js

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.ZEROX_API_KEY;
const ZEROX_BASE = "https://api.0x.org";

// 🚦 Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", message: "G-DEX Backend Alive!" });
});

// -------------------------------------------
// 1) Price Preview (GET /quote)
//    프론트에서 미리보기 용으로 사용
//    예: /quote?sellToken=0xeee...&buyToken=0xA0b8...&sellAmount=1000000000000000
// -------------------------------------------
app.get("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, taker } = req.query;

    if (!sellToken || !buyToken || !sellAmount) {
      return res.status(400).json({ error: "sellToken, buyToken, sellAmount required" });
    }

    const response = await axios.get(`${ZEROX_BASE}/swap/permit2/quote`, {
      params: {
        chainId: 1,
        sellToken,
        buyToken,
        sellAmount,
        taker,              // 선택값 (없으면 undefined 그대로 전달)
      },
      headers: {
        "0x-api-key": API_KEY,
        "0x-version": "v2",
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error("0x quote error:", err.response?.data || err.message);
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// -------------------------------------------
// 2) Execute Swap (POST /swap)
//    프론트에서 실제 스왑 직전에 호출해서
//    to / data / value 를 받아서 MetaMask에 전달
// -------------------------------------------
app.post("/swap", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, taker } = req.body;

    if (!sellToken || !buyToken || !sellAmount || !taker) {
      return res
        .status(400)
        .json({ error: "sellToken, buyToken, sellAmount, taker required" });
    }

    const response = await axios.get(`${ZEROX_BASE}/swap/permit2/quote`, {
      params: {
        chainId: 1,
        sellToken,
        buyToken,
        sellAmount,
        taker,
      },
      headers: {
        "0x-api-key": API_KEY,
        "0x-version": "v2",
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error("0x swap error:", err.response?.data || err.message);
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// -------------------------------------------
// 서버 시작
// -------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 G-DEX Backend running on port ${PORT}`);
});
