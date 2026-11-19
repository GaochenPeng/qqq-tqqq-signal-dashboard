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
