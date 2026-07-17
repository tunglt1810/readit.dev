# readit.dev MVP Deployment Guide

This guide covers deployment of the **readit.dev** Free extension and documents
the separate future-Pro backend:

1. **Frontend**: Build and load the Chrome extension locally or publish it to the Chrome Web Store.
2. **Future Pro backend**: Deploy Cloudflare Workers and the D1 database only
   when Pro features are implemented and authorized for release.
3. **Future Pro payments**: Connect Lemon Squeezy only with the corresponding
   licensing implementation.

---

## Part 1: Deploy the Chrome Extension

The extension uses **React 19 + TypeScript 6** and is bundled with **Rsbuild**.

### Step 1.1: Build the extension locally

Run this command from the repository root:

```bash
pnpm build
```

The command creates `dist/` at the repository root. It contains the compiled extension resources: `manifest.json`, popup HTML/JS/CSS, the background service worker, the offscreen document, the WASM engine, and static assets.

### Step 1.2: Load the extension for testing

1. Open Chrome or another Chromium-based browser (Brave, Edge, Opera, etc.).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `dist/` directory created in Step 1.1.
6. The **readit.dev** extension will appear in the browser's extension list.

### Step 1.3: Publish to the Chrome Web Store

1. Zip the contents *inside* `dist/` into a file such as `readit-extension.zip`.
2. Open the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/).
3. Register a Developer account. New accounts may require Google's one-time registration fee.
4. Click **Create new item** and upload the ZIP file.
5. Complete the listing, screenshots, and permission declarations from `manifest.json`.
6. Submit the item for Google's review.

For tag-driven releases through GitHub Actions, see [RELEASING.md](./RELEASING.md).

---

## Part 2: Future Pro backend deployment

This section is not required for the Free release. Free users do not call the
Worker, and the extension ZIP does not contain or depend on `backend/`.

The backend uses the **Hono** framework on **Cloudflare Workers** with **Cloudflare D1**.

### Step 2.1: Log in to the Cloudflare CLI

Install Node.js and pnpm, create a Cloudflare account, and then run:

```bash
npx wrangler login
```

The command opens a browser for authentication.

### Step 2.2: Create the D1 database

Create a database named `readit-db`:

```bash
npx wrangler d1 create readit-db
```

Cloudflare prints configuration similar to:

```toml
[[d1_databases]]
binding = "DB"
database_name = "readit-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### Step 2.3: Configure the backend Wrangler file

Open [backend/wrangler.toml](../backend/wrangler.toml) and append the `[[d1_databases]]` configuration from Step 2.2, replacing the existing `DB` binding.

### Step 2.4: Initialize the database schema

Import the schema into the remote D1 database:

```bash
npx wrangler d1 execute readit-db --remote --file=./backend/schema.sql
```

This creates the `subscriptions` and `activations` tables in production.

### Step 2.5: Configure the Lemon Squeezy webhook secret

Create a secure Cloudflare secret:

```bash
npx wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET
```

Enter a long, random secret when prompted.

### Step 2.6: Deploy the backend

Run this command from the `backend/` directory:

```bash
cd backend && npx wrangler deploy
```

Cloudflare prints the Worker URL, for example:
`https://readit-backend.yoursubdomain.workers.dev`.

---

## Part 3: Future Pro payment configuration

This section is not required for the Free release. Do not configure payment or
license secrets for a Free-only deployment.

Lemon Squeezy processes purchases and sends real-time subscription updates to the backend.

### Step 3.1: Register the webhook

1. Sign in to the [Lemon Squeezy dashboard](https://app.lemonsqueezy.com/).
2. Open **Settings > Webhooks**.
3. Click **Add Webhook**.
4. Configure:
   - **URL**: `https://readit-backend.yoursubdomain.workers.dev/webhook/lemonsqueezy`
   - **Secret**: The exact value created in Step 2.5.
   - **Events**: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_expired`, and optionally `order_created` for one-time payments.
5. Click **Save Webhook**.

### Step 3.2: Verify the webhook

Use Lemon Squeezy's **Test webhook** or **Send test event** feature to send a sample payload. Follow the Worker logs:

```bash
npx wrangler tail
```

Confirm that the Worker receives the request, validates the HMAC-SHA256 signature, and returns `200 OK`.
