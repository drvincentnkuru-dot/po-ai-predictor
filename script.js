const sequenceEl = document.getElementById("sequence");
const resultEl = document.getElementById("result");

const directionEl = document.getElementById("direction");
const reasonEl = document.getElementById("reason");
const confidenceEl = document.getElementById("confidence");

const upPctEl = document.getElementById("upPct");
const downPctEl = document.getElementById("downPct");
const sampleEl = document.getElementById("sample");

const predictBtn = document.getElementById("predict");
const clearBtn = document.getElementById("clear");

let candles = [];

/* --------------------------------
   DRAW CANDLE INPUT BUTTONS
-------------------------------- */

function renderCandles() {
  sequenceEl.innerHTML = "";

  for (let i = 0; i < 20; i++) {

    const button = document.createElement("button");

    button.className = "candle";

    if (candles[i] === "up") {
      button.classList.add("up");
      button.textContent = "UP";
    }

    else if (candles[i] === "down") {
      button.classList.add("down");
      button.textContent = "DN";
    }

    else {
      button.textContent = "•";
    }

    /* TAP = UP */

    button.addEventListener("click", function () {

      if (candles[i] === "up") {
        candles.splice(i, 1);
      }

      else {
        candles[i] = "up";
      }

      renderCandles();
    });


    /* LONG PRESS = DOWN */

    let timer;

    button.addEventListener("touchstart", function () {

      timer = setTimeout(function () {

        candles[i] = "down";

        renderCandles();

      }, 550);

    }, { passive: true });


    button.addEventListener("touchend", function () {
      clearTimeout(timer);
    });


    /* RIGHT CLICK = DOWN */

    button.addEventListener("contextmenu", function (event) {

      event.preventDefault();

      candles[i] = "down";

      renderCandles();

    });


    sequenceEl.appendChild(button);
  }
}


/* --------------------------------
   ANALYSIS ENGINE
-------------------------------- */

function analyzeMarket() {

  const data = candles.filter(Boolean);

  /* Minimum data */

  if (data.length < 10) {

    alert(
      "Please enter at least 10 recent candle results before analysis."
    );

    return;
  }


  /* --------------------------------
     BASIC FREQUENCY
  -------------------------------- */

  const upCount =
    data.filter(x => x === "up").length;

  const downCount =
    data.filter(x => x === "down").length;


  const total = data.length;


  const upRate =
    upCount / total;

  const downRate =
    downCount / total;


  /* --------------------------------
     RECENT MOMENTUM
  -------------------------------- */

  const recent =
    data.slice(-5);

  const recentUp =
    recent.filter(x => x === "up").length;

  const recentDown =
    recent.filter(x => x === "down").length;


  const momentum =
    (recentUp - recentDown) / recent.length;


  /* --------------------------------
     TRANSITION ANALYSIS
  -------------------------------- */

  let upTransitions = 0;
  let downTransitions = 0;

  for (let i = 1; i < data.length; i++) {

    if (data[i - 1] !== data[i]) {

      if (data[i] === "up") {
        upTransitions++;
      }

      else {
        downTransitions++;
      }
    }
  }


  let transitionScore = 0;

  const transitions =
    upTransitions + downTransitions;

  if (transitions > 0) {

    transitionScore =
      (upTransitions - downTransitions) /
      transitions;
  }


  /* --------------------------------
     COMBINED MODEL SCORE
  -------------------------------- */

  const frequencyScore =
    (upRate - downRate);

  const score =
    (frequencyScore * 0.55) +
    (momentum * 0.25) +
    (transitionScore * 0.20);


  /* --------------------------------
     SIGNAL DECISION
  -------------------------------- */

  let signal = "WAIT";

  if (score > 0.10) {
    signal = "UP";
  }

  else if (score < -0.10) {
    signal = "DOWN";
  }


  /* --------------------------------
     MODEL CONFIDENCE
  -------------------------------- */

  let confidence =
    50 + Math.abs(score) * 45;


  confidence =
    Math.round(
      Math.min(92, confidence)
    );


  /* --------------------------------
     DISPLAY RESULTS
  -------------------------------- */

  directionEl.textContent = signal;

  confidenceEl.textContent =
    confidence + "% model confidence";


  upPctEl.textContent =
    Math.round(upRate * 100) + "%";


  downPctEl.textContent =
    Math.round(downRate * 100) + "%";


  sampleEl.textContent =
    total;


  /* --------------------------------
     EXPLANATION
  -------------------------------- */

  if (signal === "UP") {

    reasonEl.textContent =
      "Recent frequency, momentum and transition patterns currently lean UP.";

  }

  else if (signal === "DOWN") {

    reasonEl.textContent =
      "Recent frequency, momentum and transition patterns currently lean DOWN.";

  }

  else {

    reasonEl.textContent =
      "The available signals are mixed. Waiting for stronger confirmation.";

  }


  resultEl.classList.remove("hidden");


  /* Scroll result into view on Android */

  resultEl.scrollIntoView({
    behavior: "smooth",
    block: "center"
  });
}


/* --------------------------------
   CLEAR BUTTON
-------------------------------- */

clearBtn.addEventListener("click", function () {

  candles = [];

  resultEl.classList.add("hidden");

  renderCandles();

});


/* --------------------------------
   ANALYZE BUTTON
-------------------------------- */

predictBtn.addEventListener(
  "click",
  analyzeMarket
);


/* --------------------------------
   START APPLICATION
-------------------------------- */

renderCandles();
