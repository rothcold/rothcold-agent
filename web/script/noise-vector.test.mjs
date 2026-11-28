import assert from "node:assert/strict";
import { test } from "node:test";
import * as codec from "../../.tools/web-codec/noise-codec.mjs";

const pin = "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62";
// Independent native Snow transcript adapted from Cacophony to the v1 prologue and records.
// Reproduce with `cargo run --locked --manifest-path web/noise-codec/Cargo.toml --example vector`.
const vector = [
	"ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79441c300398ef64fdd3df3ee48e6f842968",
	"95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843e19cd6a00429eceb8090886210adb9e4",
	"135525f2f2847d42388c4611e42bdc639f3511751970446131782d2491280535c2b8",
	"9ca6b0dbdb2dcca268af309243cc5ef573102b495e8759286a3bdf0435e3cecb54c1f6abf007465c909e06b8422a633a2118",
	"0369de9d4b76ea65a341d6a0e1e2ee8925e6aaa3765030b75929a03bd4e589e73a9a388792ec5d61fa51a0b49991b0e7b5e13c619fa003461c5e94f7b1249f6e4fc068d37beef5a0fe36fbdb9e",
	"438dd98e23fd5a50f36e9f3511645de130cf5cca8877aaa0a7076f58d5b72bf098b6c4551b65ad2d954961",
];
function scratch() {
	const ptr = codec.scratch_ptr();
	return new Uint8Array(codec.memory.buffer, ptr, 512 * 1024 + 1);
}
function put(hex) {
	const bytes = Buffer.from(hex, "hex");
	scratch().set(bytes);
	return bytes.length;
}
const get = (size) => Buffer.from(scratch().subarray(0, size));
const cryptoProperty = Object.getOwnPropertyDescriptor(globalThis, "crypto");
function random(fn) {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true,
		value: { getRandomValues: fn },
	});
}

test("static browser Noise codec matches the native v1 known-answer transcript", () => {
	const ephemeral = Buffer.from(
		"893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
		"hex",
	);
	random((out) => {
		assert.equal(out.length, 32);
		out.set(ephemeral);
	});
	let id = 0;
	try {
		put(pin);
		id = codec.start();
		assert(id > 0);
		assert.equal(get(48).toString("hex"), vector[0]);
		assert.equal(codec.verify(id, put(vector[1])), 0);
		const request = Buffer.from('{"type":"status"}');
		scratch().set(request);
		assert.equal(
			get(codec.request(id, request.length)).toString("hex"),
			vector[2],
		);
		assert.equal(codec.response(id, put(vector[3])), 1);
		assert.equal(get(1)[0], 3);
		assert.equal(codec.response(id, put(vector[4])), 1);
		assert.equal(get(1)[0], 3);
		const size = codec.response(id, put(vector[5]));
		assert.equal(get(size)[0], 2);
		assert.deepEqual(JSON.parse(get(size).subarray(1)), {
			type: "status",
			service: "rothcold-agent",
			version: 1,
		});
		assert.equal(
			codec.response(id, put(vector[5])),
			-1,
			"replayed nonce must not decode",
		);
	} finally {
		if (id) codec.close(id);
		Object.defineProperty(globalThis, "crypto", cryptoProperty);
	}
});

test("static browser Noise codec fails closed when its secure RNG fails", () => {
	random(() => {
		throw new Error("No secure RNG");
	});
	try {
		put(pin);
		assert.equal(codec.start(), 0);
	} finally {
		Object.defineProperty(globalThis, "crypto", cryptoProperty);
	}
});
