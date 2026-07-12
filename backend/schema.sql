-- D1 Database Schema for readit.dev
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, -- LemonSqueezy subscription ID
    email TEXT NOT NULL,
    license_key TEXT UNIQUE,
    status TEXT NOT NULL, -- 'active', 'cancelled', 'expired', etc.
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON subscriptions(email);
CREATE INDEX IF NOT EXISTS idx_subscriptions_license_key ON subscriptions(license_key);

CREATE TABLE IF NOT EXISTS activations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    email TEXT,
    license_key TEXT,
    activated_at INTEGER NOT NULL,
    UNIQUE(device_id, email),
    UNIQUE(device_id, license_key)
);

CREATE INDEX IF NOT EXISTS idx_activations_device ON activations(device_id);
