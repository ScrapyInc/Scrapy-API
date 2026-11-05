-- Users who sign up for the platform
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API keys issued to users
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT UNIQUE NOT NULL,            -- short public id, e.g. 7f3a9c2e. Embedded in the plaintext key.
  key_type TEXT NOT NULL,                 -- 'live' | 'test'
  key_last4 TEXT NOT NULL,                -- last 4 chars of the secret, for display only
  key_hash TEXT NOT NULL,                 -- HMAC-SHA256(secret, API_KEY_PEPPER). Deterministic; NOT bcrypt/argon2.
  is_active BOOLEAN NOT NULL DEFAULT true,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,                 -- null = no expiration, key lasts until revoked
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Reserved for future per-key restrictions feature
  allowed_ips TEXT[],                     -- unused until future feature
  allowed_origins TEXT[],                 -- unused until future feature
  restriction_mode TEXT DEFAULT 'none'    -- 'none' | 'ip' | 'origin' | 'both'
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
-- key_id is UNIQUE, so lookups by key_id use the unique index directly.

-- API key format and storage (enforced by Stage 1)
-- Plaintext key (shown once at issuance / rotation): sk_live_<key_id>_<secret>
--   key_id  = short random public id (e.g. 7f3a9c2e), embedded in the key so the row can be looked up by it
--   secret  = crypto.randomBytes(32) encoded as base64url (256 bits of entropy)
-- Storage:
--   key_hash = HMAC-SHA256(secret, API_KEY_PEPPER) — deterministic, indexable, compared in constant time
--   API_KEY_PEPPER lives in the app environment only; it is never written to the database.
-- bcrypt/argon2 are NOT used for API keys: they are salted (not searchable) and deliberately slow,
-- which is wrong for high-entropy random keys and would force a per-row scan on every request.

-- Subscription tiers
CREATE TABLE tiers (
  id TEXT PRIMARY KEY,                -- 'free', 'paid_starter', 'paid_pro'
  name TEXT NOT NULL,
  daily_search_cap INTEGER,           -- null = unlimited
  monthly_search_cap INTEGER,         -- null = unlimited
  credit_per_search INTEGER NOT NULL DEFAULT 1,
  credit_per_batch_query INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit balance per user
CREATE TABLE credit_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0,  -- credits
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit ledger: every top-up and deduction
CREATE TABLE credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,             -- positive = top-up, negative = deduction
  reason TEXT NOT NULL,               -- 'topup', 'x402_topup', 'api_call'
  reference_id TEXT,                  -- external payment id or api key id
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed tiers
INSERT INTO tiers (id, name, daily_search_cap, monthly_search_cap, credit_per_search, credit_per_batch_query)
VALUES
  ('free', 'Free', 100, NULL, 1, 1),
  ('paid_starter', 'Starter', 10000, NULL, 1, 1),
  ('paid_pro', 'Pro', NULL, NULL, 1, 1)
ON CONFLICT (id) DO NOTHING;