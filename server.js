require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ZEROX_API_KEY;

// 0x API Base
const ZEROX_BASE = "https://api.0x.org";

// -------------------------------------------
// 1) Price Preview (quote)
// -------------------------------------------
app.get("/quote", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount } = req.query;

    const response = await axios.get(
      `${ZEROX_BASE}/swap/permit2/quote`,
      {
        params: {
          chainId: 1,
          sellToken,
          buyToken,
          sellAmount
        },
        headers: {
          "0x-api-key": API_KEY,
          "0x-version": "v2"
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error("0x quote error:", err.response?.data || err.message);
    res.status(400).json(err.response?.data || { error: err.message });
  }
});

// -------------------------------------------
// 2) Execute Swap (0x Transaction Data 전달)
// -------------------------------------------
app.post("/swap", async (req, res) => {
  try {
    const { sellToken, buyToken, sellAmount, taker } = req.body;

    const response = await axios.get(
      `${ZEROX_BASE}/swap/permit2/quote`,
      {
        params: {
          chainId: 1,
          sellToken,
          buyToken,
          sellAmount,
          taker,
        },
        headers: {
          "0x-api-key": API_KEY,
          "0x-version": "v2"
        }
      }
    );

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
