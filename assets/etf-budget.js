const inputs = [...document.querySelectorAll("[data-etf-budget]")];
const changeEvent = "etf-budget-change";
const decimals = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let budget = inputs[0].valueAsNumber;

export function getBudget() {
  return budget;
}

export function onBudgetChange(listener) {
  document.addEventListener(changeEvent, listener);
}

export function formatAmounts(amount) {
  const inWan = amount >= 10_000;
  return {
    unit: inWan ? "万元" : "元",
    format: (value) => decimals.format(value / (inWan ? 10_000 : 1)),
  };
}

for (const input of inputs) {
  const sync = () => {
    if (!input.validity.valid) return;
    const amount = input.valueAsNumber;
    for (const peer of inputs) {
      if (peer !== input) peer.value = String(amount);
    }
    if (budget === amount) return;
    budget = amount;
    document.dispatchEvent(new Event(changeEvent));
  };
  input.addEventListener("input", sync);
  input.addEventListener("change", () => {
    if (input.reportValidity()) sync();
  });
}
