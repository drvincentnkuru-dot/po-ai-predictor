const livePairs = [
  "EUR/USD",
  "GBP/USD",
  "USD/JPY",
  "USD/CHF",
  "AUD/USD",
  "USD/CAD",
  "NZD/USD",
  "EUR/GBP",
  "EUR/JPY",
  "GBP/JPY"
];

const otcPairs = [
  "EUR/USD OTC",
  "GBP/USD OTC",
  "USD/JPY OTC",
  "USD/CHF OTC",
  "AUD/USD OTC",
  "USD/CAD OTC",
  "NZD/USD OTC",
  "EUR/GBP OTC",
  "EUR/JPY OTC",
  "GBP/JPY OTC"
];

const marketType = document.getElementById("marketType");
const pair = document.getElementById("pair");
const expiry = document.getElementById("expiry");
const analyzeBtn = document.getElementById("analyzeBtn");

const signal = document.getElementById("signal");
const confidence = document.getElementById("confidence");
const entryTime = document.getElementById("entryTime");
const expiryTime = document.getElementById("expiryTime");
const countdown = document.getElementById("countdown");

const marketLabel = document.getElementById("marketLabel");
const pairLabel = document.getElementById("pairLabel");
const dataStatus = document.getElementById("dataStatus");

const history = document.getElementById("history");
const total = document.getElementById("total");
const wins = document.getElementById("wins");
const losses = document.getElementById("losses");
const winRate = document.getElementById("winRate");

let countdownTimer = null;
let currentSignal = null;

function loadPairs() {
  const list = marketType.value === "otc" ? otcPairs : livePairs;

  pair.innerHTML = "";

  list.forEach(item => {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    pair.appendChild(option);
  });

  updateLabels();
}

function updateLabels() {
  marketLabel.textContent =
    marketType.value === "otc" ? "OTC MARKET" : "LIVE MARKET";

  pairLabel.textContent = pair.value;

  /*
    IMPORTANT:
    This version does NOT pretend to receive live Pocket Option
    candles. The status clearly shows that external market data
    still needs to be connected.
  */
  dataStatus.textContent = "DATA ADAPTER REQUIRED";
}

function getTimeString(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function analyzeMarket() {
  clearInterval(countdownTimer);

  const now = new Date();
  const duration = Number(expiry.value);

  /*
    DEMO ANALYSIS ONLY.

    This generates an example signal so that the interface can
    be tested. It is NOT a live Pocket Option prediction.
  */

  const randomValue = Math.random();

  let direction;
  let confidenceValue;

  if (randomValue < 0.45) {
    direction = "CALL";
    confidenceValue = 62 + Math.floor(Math.random() * 16);
  } else if (randomValue < 0.90) {
    direction = "PUT";
    confidenceValue = 62 + Math.floor(Math.random() * 16);
  } else {
    direction = "NO TRADE";
    confidenceValue = 50;
  }

  const end = new Date(
    now.getTime() + duration * 60 * 1000
  );

  currentSignal = {
    id: Date.now(),
    market: marketType.value,
    pair: pair.value,
    direction: direction,
    confidence: confidenceValue,
    entry: getTimeString(now),
    expiry: getTimeString(end),
    result: "PENDING"
  };

  showSignal(currentSignal);
  saveSignal(currentSignal);
  startCountdown(end);
}

function showSignal(item) {
  signal.textContent = item.direction;

  signal.className = "signal";

  if (item.direction === "CALL") {
    signal.classList.add("call");
  } else if (item.direction === "PUT") {
    signal.classList.add("put");
  } else {
    signal.classList.add("neutral");
  }

  confidence.textContent = item.confidence + "%";
  entryTime.textContent = item.entry;
  expiryTime.textContent = item.expiry;
}

function startCountdown(endTime) {
  function update() {
    const remaining = endTime.getTime() - Date.now();

    if (remaining <= 0) {
      countdown.textContent = "EXPIRED";
      clearInterval(countdownTimer);
      return;
    }

    const seconds = Math.ceil(remaining / 1000);

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    countdown.textContent =
      minutes + ":" + String(secs).padStart(2, "0");
  }

  update();
  countdownTimer = setInterval(update, 1000);
}

function getHistory() {
  try {
    return JSON.parse(
      localStorage.getItem("po_ai_history") || "[]"
    );
  } catch {
    return [];
  }
}

function saveSignal(item) {
  const list = getHistory();

  list.unshift(item);

  localStorage.setItem(
    "po_ai_history",
    JSON.stringify(list.slice(0, 50))
  );

  renderHistory();
}

function renderHistory() {
  const list = getHistory();

  if (!list.length) {
    history.innerHTML =
      '<p class="empty">No signals yet.</p>';
  } else {
    history.innerHTML = "";

    list.forEach(item => {
      const div = document.createElement("div");

      div.className = "history-item";

      div.innerHTML = `
        <div class="top">
          <strong>${item.pair}</strong>
          <strong>${item.direction}</strong>
        </div>

        <div class="bottom">
          ${item.market.toUpperCase()}
          • ${item.entry}
          • ${item.confidence}%
          • <span class="pending">${item.result}</span>
        </div>
      `;

      history.appendChild(div);
    });
  }

  updateStats(list);
}

function updateStats(list) {
  const completed = list.filter(
    item => item.result === "WIN" || item.result === "LOSS"
  );

  const winCount = list.filter(
    item => item.result === "WIN"
  ).length;

  const lossCount = list.filter(
    item => item.result === "LOSS"
  ).length;

  total.textContent = completed.length;
  wins.textContent = winCount;
  losses.textContent = lossCount;

  if (completed.length > 0) {
    winRate.textContent =
      Math.round((winCount / completed.length) * 100) + "%";
  } else {
    winRate.textContent = "0%";
  }
}

marketType.addEventListener("change", loadPairs);

pair.addEventListener("change", updateLabels);

analyzeBtn.addEventListener("click", analyzeMarket);

loadPairs();
renderHistory();
