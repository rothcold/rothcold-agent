import { memory } from "./noise-codec.mjs";

export function secure_random(offset, length) {
	try {
		const bytes = new Uint8Array(memory.buffer, offset, length);
		for (let i = 0; i < length; i += 65536)
			crypto.getRandomValues(bytes.subarray(i, i + 65536));
		return 1;
	} catch {
		return 0;
	}
}
