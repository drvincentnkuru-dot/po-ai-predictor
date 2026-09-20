const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/*
  PO AI Predictor Backend
  -----------------------
  This server is READ-ONLY.

  It does not log in to Pocket Option,
  does not place trades, and does not store
  trading passwords or private credentials.
*/

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "PO AI Predictor Backend",
    version: "3.0.0",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/candles", (req, res) => {
  res.status(503).json({
    status: "no_live_data",
    message:
      "No verified live candle data source is connected yet."
  });
});

app.get("/api/signal", (req, res) => {
  res.status(503).json({
    status: "no_live_data",
    signal: "NO TRADE",
    message:
      "Signal disabled until verified market data is available."
  });
});

app.post("/api/result", (req, res) => {
  res.json({
    status: "received",
    message: "Result endpoint is ready for the frontend."
  });
});

app.get("/api/statistics", (req, res) => {
  res.json({
    total: 0,
    wins: 0,
    losses: 0,
    winRate: 0
  });
});

app.get("/", (req, res) => {
  res.json({
    service: "PO AI Predictor Backend",
    status: "online"
  });
});

app.listen(PORT, () => {
  console.log(
    `PO AI Predictor backend running on port ${PORT}`
  );
});
