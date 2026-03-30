/**
 * Chamindra — Breakout Strategy Bridge Server
 * Receives TradingView webhook → validates → places order on Tradovate
 *
 * Setup:
 *   npm install express axios dotenv
 *   node server.js
 */

require("dotenv").config();
const express = require("express");
const axios   = require("axios");
const app     = express();
app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG  (put real values in .env)
// ─────────────────────────────────────────────
const CONFIG = {
  port          : process.env.PORT          || 3000,
  webhookSecret : process.env.WEBHOOK_SECRET || "my_secret_token",

  // Tradovate credentials — get from Tradovate → Settings → API Access
  tradovate: {
    baseUrl   : "https://live.tradovateapi.com/v1",   // use demo.tradovateapi.com for paper
    name      : process.env.TV_USERNAME,
    password  : process.env.TV_PASSWORD,
    appId     : process.env.TV_APP_ID,
    appVersion: "1.0",
    cid       : process.env.TV_CID,                   // client ID
    sec       : process.env.TV_SEC,                   // client secret
  },

  // TopOneFutures prop firm risk rules
  risk: {
    maxDailyLoss      : 500,    // USD — stop trading if daily P&L < -$500
    maxContractsPerTrade: 1,    // max 1 contract per signal
    allowedSymbols    : ["MGC", "MGCM5", "MNQ", "MNQM5", "NQ", "NQM5"],
    allowedActions    : ["buy"],  // breakout is long only
  }
};

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let accessToken   = null;
let tokenExpiry   = null;
let dailyPnL      = 0;
let tradesLog     = [];

// ─────────────────────────────────────────────
// TRADOVATE AUTH — get / refresh bearer token
// ─────────────────────────────────────────────
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && tokenExpiry && now < tokenExpiry) {
    return accessToken;
  }

  console.log("[AUTH] Requesting new Tradovate access token...");
  try {
    const res = await axios.post(
      `${CONFIG.tradovate.baseUrl}/auth/accesstokenrequest`,
      {
        name      : CONFIG.tradovate.name,
        password  : CONFIG.tradovate.password,
        appId     : CONFIG.tradovate.appId,
        appVersion: CONFIG.tradovate.appVersion,
        cid       : CONFIG.tradovate.cid,
        sec       : CONFIG.tradovate.sec,
      }
    );

    accessToken = res.data["access-token"];
    // Tradovate tokens expire in ~60 min — refresh 5 min early
    tokenExpiry = now + (55 * 60 * 1000);
    console.log("[AUTH] Token acquired, expires in 55 min.");
    return accessToken;
  } catch (err) {
    console.error("[AUTH] Failed to get token:", err.response?.data || err.message);
    throw new Error("Tradovate authentication failed");
  }
}

// ─────────────────────────────────────────────
// TRADOVATE — resolve contract ID from symbol
// ─────────────────────────────────────────────
async function getContractId(symbol) {
  const token = await getAccessToken();
  const res = await axios.get(
    `${CONFIG.tradovate.baseUrl}/contract/find?name=${symbol}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.data || !res.data.id) {
    throw new Error(`Contract not found for symbol: ${symbol}`);
  }
  return res.data.id;
}

// ─────────────────────────────────────────────
// TRADOVATE — get account ID
// ─────────────────────────────────────────────
async function getAccountId() {
  const token = await getAccessToken();
  const res = await axios.get(
    `${CONFIG.tradovate.baseUrl}/account/list`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.data || res.data.length === 0) {
    throw new Error("No Tradovate accounts found");
  }
  // Use first account (your TopOneFutures account)
  return res.data[0].id;
}

// ─────────────────────────────────────────────
// TRADOVATE — place order with bracket (entry + SL)
// ─────────────────────────────────────────────
async function placeOrder({ symbol, action, qty, sl }) {
  const token      = await getAccessToken();
  const contractId = await getContractId(symbol);
  const accountId  = await getAccountId();

  const orderSide = action === "buy" ? "Buy" : "Sell";

  // Entry: stop order (triggers when price hits entry level — breakout buy stop)
  // SL: stop order as bracket
  const orderPayload = {
    accountSpec : CONFIG.tradovate.name,
    accountId   : accountId,
    action      : orderSide,
    symbol      : symbol,
    orderQty    : qty,
    orderType   : "Stop",       // Buy Stop — enters on breakout
    isAutomated : true,
    bracket1    : {
      action   : orderSide === "Buy" ? "Sell" : "Buy",
      orderType: "Stop",
      stopPrice: sl,
      orderQty : qty,
    }
  };

  console.log("[ORDER] Placing order:", JSON.stringify(orderPayload, null, 2));

  const res = await axios.post(
    `${CONFIG.tradovate.baseUrl}/order/placeorder`,
    orderPayload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return res.data;
}

// ─────────────────────────────────────────────
// RISK GATE
// ─────────────────────────────────────────────
function passesRiskGate(payload) {
  const reasons = [];

  if (!CONFIG.risk.allowedSymbols.includes(payload.symbol)) {
    reasons.push(`Symbol ${payload.symbol} not in allowed list`);
  }

  if (!CONFIG.risk.allowedActions.includes(payload.action)) {
    reasons.push(`Action '${payload.action}' not allowed for breakout (long only)`);
  }

  if (payload.qty > CONFIG.risk.maxContractsPerTrade) {
    reasons.push(`Qty ${payload.qty} exceeds max ${CONFIG.risk.maxContractsPerTrade}`);
  }

  if (dailyPnL <= -CONFIG.risk.maxDailyLoss) {
    reasons.push(`Daily loss limit hit ($${dailyPnL}). No more trades today.`);
  }

  if (reasons.length > 0) {
    return { pass: false, reasons };
  }
  return { pass: true };
}

// ─────────────────────────────────────────────
// WEBHOOK ENDPOINT
// TradingView alert posts here
// URL: http://YOUR_SERVER:3000/webhook?secret=my_secret_token
// ─────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const secret = req.query.secret || req.headers["x-webhook-secret"];
  if (secret !== CONFIG.webhookSecret) {
    console.warn("[WEBHOOK] Unauthorised request rejected");
    return res.status(401).json({ error: "Unauthorised" });
  }

  const payload = req.body;
  console.log("\n[WEBHOOK] Received:", JSON.stringify(payload, null, 2));

  // Expected payload shape from Pine Script alert:
  // {
  //   "strategy": "BREAKOUT",
  //   "symbol":   "MGC",
  //   "action":   "buy",
  //   "qty":      1,
  //   "sl":       1850.5,
  //   "timeframe": "15",
  //   "time":     "2026-03-31T10:00:00Z"
  // }

  // Validate required fields
  const required = ["strategy", "symbol", "action", "qty", "sl"];
  for (const field of required) {
    if (payload[field] === undefined || payload[field] === null) {
      console.error(`[WEBHOOK] Missing field: ${field}`);
      return res.status(400).json({ error: `Missing field: ${field}` });
    }
  }

  // Risk gate check
  const risk = passesRiskGate(payload);
  if (!risk.pass) {
    console.warn("[RISK GATE] Trade rejected:", risk.reasons);
    logTrade({ ...payload, status: "REJECTED", reasons: risk.reasons });
    return res.status(200).json({
      status : "rejected",
      reasons: risk.reasons
    });
  }

  // Place the order
  try {
    const result = await placeOrder({
      symbol: payload.symbol,
      action: payload.action,
      qty   : payload.qty,
      sl    : payload.sl,
    });

    console.log("[ORDER] Placed successfully:", result);
    logTrade({ ...payload, status: "FILLED", orderId: result.orderId });

    return res.status(200).json({
      status : "order_placed",
      orderId: result.orderId,
      payload
    });

  } catch (err) {
    console.error("[ORDER] Failed:", err.response?.data || err.message);
    logTrade({ ...payload, status: "ERROR", error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// TRADE LOG
// ─────────────────────────────────────────────
function logTrade(entry) {
  const record = { ...entry, timestamp: new Date().toISOString() };
  tradesLog.push(record);
  console.log("[LOG]", JSON.stringify(record));
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status   : "running",
    dailyPnL,
    trades   : tradesLog.length,
    tokenLive: accessToken !== null && Date.now() < tokenExpiry,
  });
});

// View today's trade log
app.get("/trades", (req, res) => {
  res.json(tradesLog);
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`\n=== Breakout Bridge Server running on port ${CONFIG.port} ===`);
  console.log(`Webhook URL: http://YOUR_SERVER:${CONFIG.port}/webhook?secret=${CONFIG.webhookSecret}`);
  console.log(`Health check: http://YOUR_SERVER:${CONFIG.port}/health\n`);
  // Pre-fetch token on startup so first trade is instant
  getAccessToken().catch(console.error);
});
