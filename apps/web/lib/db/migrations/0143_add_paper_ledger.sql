CREATE TABLE paper_accounts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES "User"(id),
  legacy_id text NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  initial_cash numeric(24,2) NOT NULL CHECK (initial_cash > 0),
  cash numeric(24,2) NOT NULL CHECK (cash >= 0),
  frozen_cash numeric(24,2) NOT NULL CHECK (frozen_cash >= 0),
  realized_pnl numeric(24,2) NOT NULL,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(owner_id,legacy_id)
);
--> statement-breakpoint
CREATE TABLE paper_orders (
  account_id uuid NOT NULL REFERENCES paper_accounts(id),
  id text NOT NULL,
  code text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy','sell')),
  status text NOT NULL CHECK (status IN ('submitted','partially_filled','filled','cancelled','rejected')),
  quantity bigint NOT NULL CHECK (quantity > 0),
  remaining_quantity bigint NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
  limit_price numeric(24,3) NOT NULL CHECK (limit_price > 0),
  detail jsonb NOT NULL,
  PRIMARY KEY(account_id,id)
);
--> statement-breakpoint
CREATE TABLE paper_position_lots (
  account_id uuid NOT NULL REFERENCES paper_accounts(id),
  id text NOT NULL,
  code text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  remaining_quantity bigint NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity),
  cost_price numeric(24,3) NOT NULL CHECK (cost_price > 0),
  trade_date date NOT NULL,
  detail jsonb NOT NULL,
  PRIMARY KEY(account_id,id)
);
--> statement-breakpoint
CREATE TABLE paper_commands (
  account_id uuid NOT NULL REFERENCES paper_accounts(id),
  command_id text NOT NULL CHECK (length(command_id) BETWEEN 1 AND 200),
  kind text NOT NULL,
  actor text NOT NULL CHECK (length(actor) > 0),
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,command_id),
  UNIQUE(account_id,version)
);
--> statement-breakpoint
CREATE TABLE paper_fills (
  account_id uuid NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  execution_key text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  price numeric(24,3) NOT NULL CHECK (price > 0),
  amount numeric(24,2) NOT NULL CHECK (amount > 0),
  detail jsonb NOT NULL,
  PRIMARY KEY(account_id,id),
  FOREIGN KEY(account_id,order_id) REFERENCES paper_orders(account_id,id),
  UNIQUE(account_id,order_id,execution_key)
);
--> statement-breakpoint
CREATE TABLE paper_events (
  account_id uuid NOT NULL,
  version bigint NOT NULL,
  command_id text NOT NULL,
  kind text NOT NULL,
  actor text NOT NULL,
  observation jsonb NOT NULL,
  state_hash text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(account_id,version),
  FOREIGN KEY(account_id,command_id) REFERENCES paper_commands(account_id,command_id)
);
--> statement-breakpoint
CREATE TABLE paper_imports (
  account_id uuid PRIMARY KEY REFERENCES paper_accounts(id),
  migration_batch_id uuid NOT NULL UNIQUE,
  source_hash text NOT NULL,
  backup_path text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
