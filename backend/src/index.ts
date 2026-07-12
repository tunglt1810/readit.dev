import { Hono } from 'hono';

interface Env {
	DB: D1Database;
	LEMONSQUEEZY_WEBHOOK_SECRET: string;
}

const app = new Hono<{ Bindings: Env }>();

// Helper to verify LemonSqueezy webhook signature
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const keyData = encoder.encode(secret);
	const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

	const sigBuffer = hexToBytes(signature);
	const dataBuffer = encoder.encode(body);
	return await crypto.subtle.verify('HMAC', key, sigBuffer, dataBuffer);
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

// Check if a subscription status is considered active/valid for Pro tier
function isActiveStatus(status: string): boolean {
	const activeStatuses = ['active', 'on_trial'];
	return activeStatuses.includes(status.toLowerCase());
}

// 1. Webhook endpoint from LemonSqueezy
app.post('/webhook/lemonsqueezy', async (c) => {
	const signature = c.req.header('X-Signature');
	if (!signature) {
		return c.text('Missing X-Signature header', 401);
	}

	const webhookSecret = c.env.LEMONSQUEEZY_WEBHOOK_SECRET;
	const rawBody = await c.req.text();

	const isVerified = await verifySignature(rawBody, signature, webhookSecret);
	if (!isVerified) {
		return c.text('Invalid signature', 401);
	}

	try {
		const payload = JSON.parse(rawBody);
		const eventName = payload.meta?.event_name;
		const data = payload.data;

		if (!data) {
			return c.json({ success: false, message: 'Invalid payload data' }, 400);
		}

		// Process subscription events
		if (eventName && (eventName.startsWith('subscription_') || eventName === 'order_created')) {
			const id = data.id; // LemonSqueezy object ID
			const attributes = data.attributes;
			const email = attributes?.user_email?.toLowerCase();
			const status = attributes?.status || 'active'; // order_created doesn't have status, defaults to active

			if (!email) {
				return c.json({ success: false, message: 'Missing user email in payload' }, 400);
			}

			// Try to resolve license key from payload
			// LemonSqueezy sends it under attributes.license_key or first_subscription_item.license_key
			const licenseKey = attributes?.license_key || attributes?.first_subscription_item?.license_key || `LKEY-${id}`;

			const now = Date.now();

			// Save or update subscription in D1
			await c.env.DB.prepare(
				`INSERT INTO subscriptions (id, email, license_key, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           email = excluded.email,
           license_key = COALESCE(excluded.license_key, subscriptions.license_key),
           updated_at = excluded.updated_at`,
			)
				.bind(id, email, licenseKey, status, now, now)
				.run();
		}

		return c.json({ success: true });
	} catch (error) {
		const err = error as Error;
		return c.json({ success: false, error: err.message }, 500);
	}
});

interface DBSubscription {
	id: string;
	email: string;
	license_key: string;
	status: string;
	created_at: number;
	updated_at: number;
}

type SubscriptionMatch = {
	subscription: DBSubscription;
	matchedBy: 'email' | 'licenseKey';
};

// Helper function to check subscription in DB
async function findActiveSubscription(db: D1Database, email?: string, licenseKey?: string): Promise<SubscriptionMatch | null> {
	if (email) {
		const subscription = await db.prepare(`SELECT * FROM subscriptions WHERE email = ? LIMIT 1`).bind(email.toLowerCase()).first<DBSubscription>();
		if (subscription) {
			return { subscription, matchedBy: 'email' };
		}
	}

	if (licenseKey) {
		const subscription = await db.prepare(`SELECT * FROM subscriptions WHERE license_key = ? LIMIT 1`).bind(licenseKey).first<DBSubscription>();
		if (subscription) {
			return { subscription, matchedBy: 'licenseKey' };
		}
	}

	return null;
}

// 2. Device Activation Endpoint
app.post('/api/activate', async (c) => {
	try {
		const { email, licenseKey, deviceId } = await c.req.json();

		if (!deviceId) {
			return c.json({ success: false, message: 'Thiếu deviceId.' }, 400);
		}

		if (!email && !licenseKey) {
			return c.json({ success: false, message: 'Cần cung cấp email hoặc License Key.' }, 400);
		}

		// Lookup subscription
		const match = await findActiveSubscription(c.env.DB, email, licenseKey);
		const subscription = match?.subscription;

		if (!subscription || !isActiveStatus(subscription.status)) {
			return c.json(
				{
					success: false,
					message: 'Không tìm thấy subscription bản quyền đang hoạt động cho thông tin này.',
				},
				400,
			);
		}

		// Register/update device activation
		const now = Date.now();
		if (match.matchedBy === 'email') {
			await c.env.DB.prepare(
				`INSERT INTO activations (device_id, email, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id, email) DO UPDATE SET activated_at = excluded.activated_at`,
			)
				.bind(deviceId, email.toLowerCase(), now)
				.run();
		} else {
			await c.env.DB.prepare(
				`INSERT INTO activations (device_id, license_key, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id, license_key) DO UPDATE SET activated_at = excluded.activated_at`,
			)
				.bind(deviceId, licenseKey, now)
				.run();
		}

		return c.json({
			success: true,
			tier: 'pro',
			message: 'Kích hoạt Pro thành công.',
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return c.json({ success: false, error: errorMessage }, 500);
	}
});

// 3. License Re-validation Endpoint
app.post('/api/validate', async (c) => {
	try {
		const { email, licenseKey, deviceId } = await c.req.json();

		if (!deviceId) {
			return c.json({ success: false, tier: 'free', message: 'Thiếu deviceId.' }, 400);
		}

		// Check database for active subscription
		const match = await findActiveSubscription(c.env.DB, email, licenseKey);
		const subscription = match?.subscription;

		if (!subscription || !isActiveStatus(subscription.status)) {
			return c.json({
				success: false,
				tier: 'free',
				message: 'Subscription đã hết hạn hoặc không hợp lệ.',
			});
		}

		// Optional: Verify if the device was previously activated
		let hasActivation = false;
		if (match.matchedBy === 'email') {
			const act = await c.env.DB.prepare(`SELECT 1 FROM activations WHERE device_id = ? AND email = ? LIMIT 1`)
				.bind(deviceId, email.toLowerCase())
				.first();
			hasActivation = !!act;
		} else {
			const act = await c.env.DB.prepare(`SELECT 1 FROM activations WHERE device_id = ? AND license_key = ? LIMIT 1`)
				.bind(deviceId, licenseKey)
				.first();
			hasActivation = !!act;
		}

		if (!hasActivation) {
			// Auto-activate on validation check if subscription is valid
			const now = Date.now();
			if (match.matchedBy === 'email') {
				await c.env.DB.prepare(`INSERT INTO activations (device_id, email, activated_at) VALUES (?, ?, ?)`)
					.bind(deviceId, email.toLowerCase(), now)
					.run();
			} else {
				await c.env.DB.prepare(`INSERT INTO activations (device_id, license_key, activated_at) VALUES (?, ?, ?)`)
					.bind(deviceId, licenseKey, now)
					.run();
			}
		}

		return c.json({
			success: true,
			tier: 'pro',
			message: 'Bản quyền Pro hợp lệ.',
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return c.json({ success: false, tier: 'free', error: errorMessage }, 500);
	}
});

export default app;
