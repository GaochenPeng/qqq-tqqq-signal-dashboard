CREATE TABLE IF NOT EXISTS etf_daily_bars (
  fund_code text NOT NULL CHECK (fund_code ~ '^[0-9]{6}$'),
  session_date date NOT NULL,
  open_price double precision NOT NULL CHECK (open_price > 0),
  close_price double precision NOT NULL CHECK (close_price > 0),
  PRIMARY KEY (fund_code, session_date)
);

CREATE TABLE IF NOT EXISTS etf_iopv_quotes (
  fund_code text NOT NULL CHECK (fund_code ~ '^[0-9]{6}$'),
  quoted_at timestamptz NOT NULL,
  last_price double precision NOT NULL CHECK (last_price > 0),
  iopv double precision NOT NULL CHECK (iopv > 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fund_code, quoted_at)
);

CREATE TABLE IF NOT EXISTS etf_forecast_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  origin_date date NOT NULL,
  horizon smallint NOT NULL CHECK (horizon > 0),
  input_sha256 text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS etf_forecast_runs_input ON etf_forecast_runs (input_sha256);

CREATE TABLE IF NOT EXISTS etf_factor_index_closes (
  index_code text NOT NULL CHECK (index_code IN ('NDX', 'NBI')),
  session_date date NOT NULL,
  close_price double precision NOT NULL CHECK (close_price > 0),
  PRIMARY KEY (index_code, session_date)
);

CREATE TABLE IF NOT EXISTS etf_investment_plan (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  budget_yuan bigint NOT NULL CHECK (budget_yuan BETWEEN 1 AND 90071992547409),
  start_month date NOT NULL CHECK (EXTRACT(day FROM start_month) = 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE etf_investment_plan
  ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT 'trend-vol-premium-v1',
  ADD COLUMN IF NOT EXISTS installments smallint NOT NULL DEFAULT 12 CHECK (installments > 0);

CREATE TABLE IF NOT EXISTS etf_plan_trades (
  entry_key uuid PRIMARY KEY,
  plan_id smallint NOT NULL DEFAULT 1 REFERENCES etf_investment_plan (id),
  fund_code text NOT NULL CHECK (fund_code IN ('159660', '513110', '159941', '513290')),
  traded_on date NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  shares bigint NOT NULL CHECK (shares BETWEEN 1 AND 9007199254740991),
  amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 1 AND 9007199254740991),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS etf_plan_trades_by_date ON etf_plan_trades (plan_id, traded_on, recorded_at, entry_key);
