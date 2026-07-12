# Licensing and Backend Architecture

> **Status:** Future Pro architecture. This ADR is not part of the current
> Free MVP runtime, build, or release package. See the [Free MVP Design
> Specification](../superpowers/specs/2026-07-12-free-mvp-design.md).

## 1. Client-side license cache with TTL

The extension validates the **License Key** through the backend on first use, caches the result in `chrome.storage.local` for 24 hours, and periodically re-validates it. This is preferable to a server-side-only approach (slow and blocking to the UX) or a self-contained JWT (more complex and requires key rotation). A 24-hour exploitation window is an acceptable risk for a $4.99/month product.

**Considered options:**

- **Server-side only**: Most secure, but every check requires a network request and adds latency when the user presses play.
- **Self-contained signed token**: Avoids a server request for every check, but makes the backend more complex through signing and key rotation.
- **Client-side cache (chosen)**: Balances UX and security — validate once, cache for 24 hours, and re-validate after the TTL expires.

**Consequences:**

- All paid cloud API calls (translation and AI summaries) go through the backend. The backend checks the license before proxying, so this is the real feature gate and does not depend on the client-side cache. TTS runs on-device through Supertonic and does not use the backend.
- Client-side verification logic is obfuscated to discourage casual tampering.
- The cache only controls UI state (whether Pro controls are shown); it is not a security boundary.
- When a **Subscription** is cancelled or expires, the UI may show Pro for up to 24 hours because of the TTL. The backend blocks paid API calls in real time through the webhook, so there is no meaningful financial exposure.

---

## 2. Chrome profile email as the primary identity

Use `chrome.identity.getProfileUserInfo()` to read the Chrome profile email and match it against the purchasing email from Lemon Squeezy to determine the **Tier**. Keep the **License Key** as a fallback when the emails do not match.

This is preferable to a License-Key-only flow (poor UX because users must copy and paste) or a Chrome-email-only flow (fails when the purchasing email differs from the Chrome email). The extension requests the `identity.email` permission only when necessary.

**Considered options:**

- **License Key only**: Poor UX; users must enter the key manually or follow a deep link. It does not use the existing Chrome profile identity.
- **Chrome email only**: Simplest, but fails when the emails differ and provides no fallback.
- **Chrome email + License Key fallback (chosen)**: About 90% of users activate automatically through an email match; the remaining users enter a License Key manually.

**Consequences:**

- The manifest declares `"optional_permissions": ["identity.email"]`, not a required permission. The extension requests it only when the user selects Upgrade to Pro, preserving the Free-tier install rate.
- The backend must accept both an email and a License Key for validation.
- The Lemon Squeezy checkout must capture the correct purchasing email because it is the primary identifier.

---

## 3. Cloudflare Workers and D1 backend

Use Cloudflare Workers (Hono) with D1 (SQLite at the edge) for license validation, webhook handling, and translation/AI-summary API proxying. This is suitable from MVP to approximately 500 users because it has a low cost, no cold start, and uses the same language as the extension.

**Considered options:**

- **Go on Fly.io + SQLite**: Flexible with less vendor lock-in, but requires server and Dockerfile management. Estimated cost: $0–5/month.
- **Hono on Vercel + Neon Postgres**: Good developer experience, but cold starts could affect webhook reliability.
- **Cloudflare Workers + D1 (chosen)**: Low cost, no cold start, one-command deployment, and a D1 free tier.

### Migration path when scaling

| Stage | Users | Action |
| --- | ---: | --- |
| 1 | 0–5K | Keep Workers + D1 on the free tier. |
| 2 | 5K–50K | Upgrade to Workers Paid ($5/month) and D1 Paid without changing the application code. |
| 3 | 50K+ | Move translation and AI proxying to separate Workers or Fly.io. |
| 4 | 100K+ | Evaluate Turso (LibSQL) if multi-region writes are needed. |

**Consequences:**

- Moderate vendor lock-in: the Workers API is used for the D1 binding, but Hono remains portable.
- D1 is SQLite, so there are no stored procedures and concurrent writes are limited. This is acceptable for a read-heavy workload where license checks greatly outnumber webhook writes.
- The migration path is explicit at each scale threshold, so the MVP does not need to be over-engineered.
