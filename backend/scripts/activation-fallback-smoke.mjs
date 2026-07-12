import app from '../src/index.ts';

const subscriptions = [
	{
		id: 'sub-1',
		email: 'buyer@example.com',
		license_key: 'PRO-KEY-123',
		status: 'active',
		created_at: 1,
		updated_at: 1,
	},
];
const activations = [];

class FakeStatement {
	constructor(sql) {
		this.sql = sql;
		this.args = [];
	}

	bind(...args) {
		this.args = args;
		return this;
	}

	async first() {
		if (this.sql.includes('FROM subscriptions WHERE email')) {
			return subscriptions.find((subscription) => subscription.email === this.args[0]) ?? null;
		}
		if (this.sql.includes('FROM subscriptions WHERE license_key')) {
			return subscriptions.find((subscription) => subscription.license_key === this.args[0]) ?? null;
		}
		if (this.sql.includes('FROM activations') && this.sql.includes('AND email')) {
			return activations.find((activation) => activation.device_id === this.args[0] && activation.email === this.args[1]) ? { 1: 1 } : null;
		}
		if (this.sql.includes('FROM activations') && this.sql.includes('AND license_key')) {
			return activations.find((activation) => activation.device_id === this.args[0] && activation.license_key === this.args[1]) ? { 1: 1 } : null;
		}
		throw new Error(`Unsupported first() query: ${this.sql}`);
	}

	async run() {
		if (this.sql.includes('(device_id, email')) {
			const [device_id, email] = this.args;
			const existing = activations.find((activation) => activation.device_id === device_id && activation.email === email);
			if (existing) {
				existing.activated_at = this.args[2];
			} else {
				activations.push({ device_id, email, activated_at: this.args[2] });
			}
			return { success: true };
		}
		if (this.sql.includes('(device_id, license_key')) {
			const [device_id, license_key] = this.args;
			const existing = activations.find((activation) => activation.device_id === device_id && activation.license_key === license_key);
			if (existing) {
				existing.activated_at = this.args[2];
			} else {
				activations.push({ device_id, license_key, activated_at: this.args[2] });
			}
			return { success: true };
		}
		throw new Error(`Unsupported run() query: ${this.sql}`);
	}
}

const db = {
	prepare(sql) {
		return new FakeStatement(sql);
	},
};
const env = { DB: db, LEMONSQUEEZY_WEBHOOK_SECRET: 'local_dev_secret' };

async function post(path, body) {
	const response = await app.fetch(
		new Request(`http://local.test${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, body: await response.json() };
}

const activation = await post('/api/activate', {
	email: 'wrong@example.com',
	licenseKey: 'PRO-KEY-123',
	deviceId: 'device-1',
});
if (activation.status !== 200 || activation.body.success !== true) {
	throw new Error(`Fallback activation failed: ${JSON.stringify(activation)}`);
}
if (activations.length !== 1 || activations[0].license_key !== 'PRO-KEY-123' || activations[0].email) {
	throw new Error(`Fallback activation used the wrong identity: ${JSON.stringify(activations)}`);
}

const validation = await post('/api/validate', {
	email: 'wrong@example.com',
	licenseKey: 'PRO-KEY-123',
	deviceId: 'device-1',
});
if (validation.status !== 200 || validation.body.success !== true) {
	throw new Error(`Fallback validation failed: ${JSON.stringify(validation)}`);
}

console.log('Activation fallback smoke check passed.');
