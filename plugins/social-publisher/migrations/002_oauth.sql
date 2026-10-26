CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_oauth_states (
  state_hash text PRIMARY KEY,
  company_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('instagram','facebook_page','threads','x')),
  initiator_id text NOT NULL,
  state_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS social_oauth_states_expiry_idx ON plugin_social_publisher_f5a795450a.social_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS plugin_social_publisher_f5a795450a.social_oauth_tokens (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  account_id uuid,
  provider text NOT NULL CHECK (provider IN ('instagram','facebook_page','threads','x')),
  initiator_id text NOT NULL,
  token_ciphertext jsonb NOT NULL,
  expires_at timestamptz,
  enrollment_expires_at timestamptz,
  refresh_claim text,
  refresh_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_oauth_tokens_account_idx ON plugin_social_publisher_f5a795450a.social_oauth_tokens(company_id,account_id);
