# QQQ/TQQQ Decision Cockpit

Local-first bilingual QQQ/TQQQ decision cockpit for three signals, monthly contributions, and intra-month upgrades:

- CAPE rolling 30-year percentile (S&P broad valuation anchor, not Nasdaq PE)
- Nasdaq-100 rolling 5-year drawdown, mild-drawdown cue, and fast-crash check
- VIX 5-day average as a cross-asset panic proxy

It also includes an interactive DCA workbench comparing five visible strategies: QQQ DCA, Tactical QQQ, TQQQ DCA, Tactical TQQQ, and a three-signal QQQ/TQQQ timing rule. Backtests use a fixed $1,000 monthly contribution.
The chart can optionally overlay actual QQQ closing prices on a right-side y-axis.

The workbench adds:

- Position weights for the signal strategy: cash, QQQ, and TQQQ.
- Event recaps for major regimes such as dot-com, 2008, 2020, 2022, and 2025, labeled when a window contains synthetic TQQQ.
- Action attribution by rule type (path-linked, not causal alpha).
- Historical threshold-robustness diagnostic using risk-adjusted excess versus QQQ (walk-forward style splits). This is not independent out-of-sample evidence: the default thresholds were informed by these historical results, the validation windows overlap, and thresholds are frozen as of 2026-07 (ruleset v6). Genuine forward evidence can only accumulate from the freeze onward.
- Data-quality coverage showing real ETF history versus synthetic pre-inception ranges.
- Execution-mode cards explaining Tactical QQQ and Tactical TQQQ as single-ETF reference modes.
- Actual-TQQQ headline evidence, an average-allocation static diagnostic, longest relative underperformance, and excess-return Sharpe.
- Conservative, standard, and aggressive risk policies that change exposure caps without changing signal thresholds.
- Browser-local holdings, next-session manual order drafts, recurring calendar export, and an execution journal.
- CSV export and shareable URLs.

Account inputs and journal entries stay in browser `localStorage`. They are never sent to the API, and this app never sends an order to a broker.

## Trust contract

- Ruleset: `2026-07-v7`.
- A signal observed at a daily close executes at the next trading session; the backtest never trades at the same close that generated the signal.
- Backtests use bundled, versioned snapshots instead of live upstream requests, so the same commit reproduces the same result.
- The default view starts on TQQQ's first actual-history date, 2010-02-11. Earlier audit windows remain available, and their headline evidence excludes synthetic TQQQ history.
- Every buy and sell includes selectable 0, 5, or 10 basis points of friction; 5 bps is the default.
- Snapshot fallback is allowed while each source remains inside its freshness window; truly stale signal data disables the current action and stale ETF quotes disable order drafting.
- Market snapshots and order drafts expire locally after 30 minutes and must be refreshed before use.
- Historical monthly CAPE observations become visible to the backtest in the following month, avoiding use of a full-month average at that month's open.
- Sharpe uses monthly unit-NAV excess returns over the modeled cash rate.
- The allocation-matched benchmark is an ex-post diagnostic using the signal strategy's average cash, QQQ, and TQQQ weights; it is not a pre-registered investable rule.

## Signal Rule

Decision priority:

1. 2-3 low signals: bottom attack
2. Post-bottom ramp window: continue lifting TQQQ
3. 1 core low signal: small QQQ add
4. Fast crash with no core low signal: crash defense
5. Mild drawdown: small QQQ add
6. Bubble heat for 6+ months: trim TQQQ
7. Expensive near highs or bubble watch: throttle to half-size core QQQ buying and pause new TQQQ
8. Otherwise: normal DCA

Low signals:

- Valuation cheap: CAPE percentile below 35, or below 50 while Nasdaq-100 is down 25%+
- Deep drawdown: Nasdaq-100 drawdown at or below -20%
- Panic VIX: 5-day average at or above 32

Soft cue:

- Mild drawdown at or below -12% can trigger a small-dip buy without counting as a core low signal

Execution:

- Monthly cash is contributed on the first trading day.
- Intra-month upgrades can raise the action to small-dip buy, bottom attack, or crash defense if conditions worsen after the open.
- The action executes at the next trading session in backtests and appears as a manual next-session draft in the cockpit.
- A decision made on a month's last close executes as a carry-in on the first session of the next month and is recorded on that month's point as `carryIn`; it never replaces the new month's own month-start action.
- Signal memory (post-bottom ramp and heat-month counters) advances when a decision is confirmed at a close, while the portfolio trade executes at the next session.
- Quiet VIX alone no longer forces pause or heat trim.

Risk policies reuse these same signals:

- Conservative: QQQ and cash only; TQQQ cap 0%.
- Standard: the main mixed-strategy and backtest policy, with a 40% TQQQ cap, 10% normal floor, 25% bottom target, and 40% post-bottom target.
- Aggressive: optional manual-execution scenario, with a 20% normal floor, 35% bottom target, and 90% monthly-review cap. Market moves can drift above the cap between manual reviews.

Position rules for the mixed signal strategy:

- 2-3 low signals: deploy up to about one third of cash into TQQQ toward a 25% initial target, then spend the next 6 months moving toward a 40% TQQQ target.
- 1 low signal or mild drawdown: buy QQQ with up to 2x the monthly contribution.
- Fast crash before any core low signal: sell about half of TQQQ into cash and do not buy QQQ/TQQQ that month.
- Fast-crash defense is historically rare (zero executions in the default actual-TQQQ headline sample); treat it as a mechanical guardrail, not validated crash insurance.
- Expensive near highs or bubble watch: invest 50% of the monthly contribution in core QQQ, pause new TQQQ buying, and retain the other 50% as cash.
- Sustained bubble heat for 6+ months: invest 50% of the monthly contribution in core QQQ while selling about 1/12 of TQQQ monthly and keeping a 10% TQQQ floor. This is a shift from leveraged to unleveraged exposure, not contradictory trading.
- Normal regime: refill the 10% TQQQ floor first, then buy QQQ; drip surplus cash back at roughly 1/6 per month.

The Tactical QQQ and Tactical TQQQ variants reuse the same monthly signal decision but restrict the execution universe:

- Tactical QQQ: buy QQQ in normal, dip, and bottom regimes; pause near highs; sell about 25% of QQQ during fast-crash regimes and about 1/12 during heat regimes.
- Tactical TQQQ: buy TQQQ in normal, dip, and bottom regimes; pause near highs; sell partial TQQQ during fast-crash and heat regimes.

The API still returns the old new-cash 80/20 compatibility strategy, but the main UI, metric cards, and CSV export hide it.

## Why these defaults

Historical first-of-month sampling under the old rules had two hard failures:

- CAPE below the 20th percentile never fired after 1985 in monthly samples, so valuation-cheap was dead.
- COVID March 2020 hit 2 low signals mid-month, but the first trading day still looked normal, so the strategy missed the bottom and later sold on panic alone.

Defaults now use a live-enough cheap threshold, core-low priority over crash sells, a reachable fast-crash branch before the softer mild-drawdown cue, and intra-month upgrades.

The 50% high-regime QQQ rate and the standard TQQQ limits are deliberately simple risk controls, not optimized parameters. The standard policy lowers leverage relative to the optional aggressive scenario, but it can still lag QQQ in strong bull markets and lose materially during drawdowns. Treat all historical comparisons as path-dependent evidence rather than a promise of future outperformance.

Use the mixed rule as a tactical contribution and leverage overlay, not as a universal promise to beat QQQ from every start date. Existing holdings still make outcomes path-dependent; a future target-allocation ruleset would be needed to remove that limitation rather than merely reduce it.

## Local Dev

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:8765
```

### China-listed ETF analysis

The home-page **China ETF analysis** link opens `/cn-etf.html`. **刷新行情** requests a new batch of last prices, IOPV and asks from Tencent for the 12 Nasdaq-100 ETFs. The page displays the quote timestamp and labels the last valid snapshot when the source is unavailable.

The RMB backtest uses adjusted daily opens and closes from Eastmoney. The amount defaults to CNY 1,000,000 and can be edited in yuan in either the backtest or cost panel. The fields stay in sync. Run the backtest to apply the new amount to the results. The cost panel recalculates from its displayed quotes after the amount is edited. The page preselects 159660, 513110, 159941 and 513290 from 13 available funds. Compare a lump sum, 12 monthly installments and the existing unleveraged signal policy with execution on the eligible Chinese session after the U.S. signal. The page shows the actual dates, scope and assumptions used.

Use the backtest view selector to switch between the selected portfolio and each ETF. The portfolio splits the amount equally. Each ETF in its own view uses the full amount. Buy counts reflect simulated purchases of individual funds. The 1%, 3%, 5% and 8% premium rules are available for 159660, 513110, 159941 and 513290. A rule checks the first eligible opening in each month, uses the unadjusted opening price against official NAV available under the T+3-open convention, then invests that ETF’s remaining allotment in one purchase. Historical intraday IOPV is unavailable in the source used for this comparison.

After the Chinese session closes, update the daily bars with `npm run update:cn-etf-history` and the saved premium inputs with `npm run update:cn-etf-premiums`. Local backtests read the refreshed files on their next request.

#### Out-of-sample ETF factor comparison

The default comparison starts in 2025 and uses the same dates, RMB budget, adjusted ETF prices and 5 bp trading friction for the lump sum, monthly installments and factor strategy. The four-fund factor portfolio assigns 75% of scheduled capital to Nasdaq-100 and 25% to Nasdaq Biotechnology. The standalone view applies the same rule to the selected fund with the full input budget.

The first common session in each of the first 12 months is an opportunity to spend one tranche per index. A nonpositive 126-session index return and an above-threshold 20-session annualized volatility each halve that group's tranche. Volatility and premium caps are the 80th percentiles of observations available in the 2023–2024 calibration window. At each decision only prior U.S. closes and prior ETF opening-premium estimates are used to rank candidates. The current eligible unit NAV determines the selected fund's limit price. Its unadjusted opening price determines whether the limit order fills. Undeployed amounts stay in cash. The decision log shows the input dates, reasons, comparison prices and gross outlay per fill.

Run `npm run update:cn-etf-factors` to fetch the two official Nasdaq close series (NASDAQ100 and NASDAQNBI) via FRED since 2022 for warm-up. The updater also archives the index closes in local PostgreSQL when configured. The local index snapshot, adjusted ETF daily history and T+3 premium inputs reproduce the evaluation. The historical premium estimate uses the last eligible disclosed NAV. A simulated fill uses fractional shares at the recorded opening price when its limit is met. The existing strategies are available under **全部策略**.

### 20-day China ETF forecasts and local data

The **20 日预测** tab shows P10, median, and P90 forecasts of RMB returns for 159660, 513110, 159941, and 513290. The screen keeps the historical comparison alongside each forecast. It selects the lowest average quantile loss across P10, P50, and P90.

The protocol follows the principle of comparing methods on identical windows from the [FinVerse study](https://github.com/LGAI-Research/EXAONE-Forecast/blob/main/domains/finance/README.md). FinVerse additionally tests cross-asset ranking and a top-ranked portfolio, which are separate tasks. Here the target is each selected ETF’s front-adjusted close-to-close return 20 Chinese trading sessions forward. At each origin, both neural candidates see at most 512 daily closes through that date. Three transparent rules use historical returns available at that date. The EWMA rule uses a fixed daily decay of 0.94.

The fixed retrospective run spans 2025-11-18 to 2026-11-16. It contains 12 non-overlapping origins and 48 ETF outcomes, with common market exposure within each origin.

| Candidate | Quantile loss (pp) | Median MAE (pp) | P10–P90 coverage |
| --- | ---: | ---: | ---: |
| Chronos-2 | 1.428 | 4.833 | 38/48 |
| Simons-297M | 1.526 | 4.910 | 36/48 |
| Historical mean and empirical interval | 1.532 | 5.185 | 25/48 |
| Flat center and EWMA-scaled interval | 1.536 | 5.225 | 35/48 |
| Flat center and empirical interval | 1.620 | 5.225 | 29/48 |

This prototype selects Chronos-2 on the retrospective score. P10–P90 is the model's nominal interval. Its empirical coverage and the forecast's origin, generation time, underlying data fingerprint, and checkpoint revision are stored for future verification. The retrospective run cannot establish whether a pretrained model saw related public financial series. The existing trading rule backtests are separate from these forecasts.

Install JavaScript dependencies with `npm ci`. Supply a private `.env.local` with `ETF_POSTGRES_PASSWORD` and `ETF_DATABASE_URL`. The compose file creates database `nasdaq_etf` with user `nasdaq_etf`, bound to `127.0.0.1:55436` and backed by a Docker named volume.

```bash
docker compose --env-file .env.local -f compose.etf.yml up -d --wait
uv sync --project forecast --locked
uv run --project forecast --locked python forecast/fetch_models.py
npm run forecast:run
npm run dev
```

Update forecasts in the tab or with `npm run forecast:run`. A run refreshes the daily archives, imports front-adjusted OHLC into PostgreSQL, archives the current public IOPV batch, and stores the results. Re-running the same inputs and model revisions reuses the saved record. Market refreshes also archive IOPV observations, including 513290. The quote table starts with observations saved locally from this integration. The live history JSON files, database credentials, database volume, and model weights are local artifacts. `npm run forecast:run -- --from-snapshot --rules-only` uses the existing market archive and the standard Python rules without model weights. The GitHub checkout can regenerate the A-share backtest data through `npm run update:cn-etf-history` and then `npm run update:cn-etf-premiums`.

## Check

```bash
npm test
npm run test:research
```

`npm test` is the production gate: engine unit/integration tests plus `scripts/check.cjs` audits across all ten supported start windows against versioned snapshots. It must pass after every snapshot update; live upstream access is not required.

`npm run test:research` runs the frozen pre-registered research studies (baseline, TQQQ sleeve, single-state attribution, one-way floor, CAPE convention). These pin a specific data snapshot; once the bundled data moves past their frozen snapshot, their tests skip automatically instead of failing, so snapshot updates never break the suite.

Live upstream smoke test:

```bash
npm run check:live
```

Refresh bundled market snapshots:

```bash
npm run update-data
```

Deployment diagnostics:

```text
/api/health
```

## Deploy

Import the repository into Vercel. The static page is `index.html`; serverless API routes live in `api/`.

## Data

- Nasdaq-100: Yahoo Finance `^NDX`
- QQQ adjusted close: Yahoo Finance `QQQ`
- TQQQ adjusted close: Yahoo Finance `TQQQ`
- VIX: Yahoo Finance `^VIX`
- Short rate: FRED `FEDFUNDS`
- CAPE/Shiller PE: Multpl monthly table
- Static fallback snapshots live in `data/` and are refreshed after US trading days by GitHub Actions. Pull requests and pushes to `main` run deterministic tests.

Backtests use adjusted QQQ/TQQQ closes when available. Before QQQ/TQQQ live history exists, QQQ is proxied from Nasdaq-100 with a 0.7% annual dividend approximation and TQQQ is synthesized from 3x daily Nasdaq-100 returns after a 0.95% annual expense-ratio drag and approximate 2x financing cost. Cash earns FRED FEDFUNDS when available, with a coarse historical fallback. The hidden 80/20 compatibility variant allocates each new monthly contribution 80% to QQQ and 20% to TQQQ, without rebalancing existing holdings. Backtests include the selected flat trading friction but still exclude tax, residual tracking error after inception, borrowing limits, and broker execution constraints.

The free CAPE table is not a point-in-time revision archive. Backtests delay each monthly value until the next month to remove mechanical same-month look-ahead, but historical revision bias remains an explicit limitation; do not interpret threshold precision as causal evidence.

Buying TQQQ shares with cash does not create daily broker margin calls. The fund's internal financing, derivatives, fees, daily compounding, and tracking effects are reflected in actual adjusted TQQQ prices after inception and approximated in synthetic pre-inception data. If the investor uses broker margin to buy TQQQ, margin interest is outside this model and must be added separately.

## Decision use

Treat the top panel as a monthly process control, not a prediction machine:

1. Read the effective month action and qualitative rule strength.
2. Compare month-open lock versus live preview. An upgrade means conditions worsened after the open.
3. Check the vs-QQQ edge card for historical path cost, especially max drawdown and underperformance months.
4. Enter holdings locally, select a risk policy, and review the next-session order draft before acting manually.
5. If you only hold QQQ or only hold TQQQ, compare the draft with the matching tactical reference card.
6. Re-check once near month open, and again if the market is crashing mid-month.

This is a research and process tool, not investment advice.
