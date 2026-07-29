export interface Mp3Inspection {
	frameCount: number;
	bitrateKbps: number;
	channelCount: 1 | 2;
	durationSeconds: number;
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;

function id3v2Length(bytes: Uint8Array): number {
	if (bytes.length < 10 || String.fromCharCode(...bytes.subarray(0, 3)) !== 'ID3') {
		return 0;
	}
	const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
	return 10 + size + (bytes[5] & 0x10 ? 10 : 0);
}

function parseFrame(bytes: Uint8Array, offset: number) {
	if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
		throw new Error(`Invalid MP3 frame sync at byte ${offset}.`);
	}
	const version = (bytes[offset + 1] >> 3) & 0x03;
	const layer = (bytes[offset + 1] >> 1) & 0x03;
	const bitrateIndex = bytes[offset + 2] >> 4;
	const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
	const padding = (bytes[offset + 2] >> 1) & 0x01;
	const channelMode = bytes[offset + 3] >> 6;
	if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
		throw new Error(`Unsupported or invalid MPEG Layer III header at byte ${offset}.`);
	}
	const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex] as number;
	const sampleRate = version === 3 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
	const bitrateKbps = (version === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES)[bitrateIndex] as number;
	const samplesPerFrame = version === 3 ? 1_152 : 576;
	const frameLength = Math.floor(((version === 3 ? 144_000 : 72_000) * bitrateKbps) / sampleRate) + padding;
	if (frameLength < 4 || offset + frameLength > bytes.length) {
		throw new Error(`Truncated MP3 frame at byte ${offset}.`);
	}
	const frameText = String.fromCharCode(...bytes.subarray(offset + 4, offset + frameLength));
	return {
		bitrateKbps,
		channelCount: (channelMode === 3 ? 1 : 2) as 1 | 2,
		sampleRate,
		samplesPerFrame,
		frameLength,
		isInfoFrame: frameText.includes('Info') || frameText.includes('Xing'),
	};
}

export function inspectMp3(bytes: readonly number[] | Uint8Array): Mp3Inspection {
	const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	const end = data.length >= 128 && String.fromCharCode(...data.subarray(-128, -125)) === 'TAG' ? data.length - 128 : data.length;
	let offset = id3v2Length(data);
	let first: ReturnType<typeof parseFrame> | null = null;
	let frameCount = 0;
	while (offset < end) {
		const frame = parseFrame(data.subarray(0, end), offset);
		offset += frame.frameLength;
		if (frame.isInfoFrame) {
			continue;
		}
		if (
			first &&
			(frame.bitrateKbps !== first.bitrateKbps || frame.channelCount !== first.channelCount || frame.sampleRate !== first.sampleRate)
		) {
			throw new Error(`Inconsistent MP3 frame headers: ${JSON.stringify({ first, frame })}`);
		}
		first ??= frame;
		frameCount += 1;
	}
	if (!first || frameCount === 0 || offset !== end) {
		throw new Error('No complete MP3 frames found.');
	}
	return {
		frameCount,
		bitrateKbps: first.bitrateKbps,
		channelCount: first.channelCount,
		durationSeconds: (frameCount * first.samplesPerFrame) / first.sampleRate,
	};
}
