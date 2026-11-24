import assert from "node:assert/strict";
import test from "node:test";
import { pending, requestFor } from "./chat.ts";

test("resubmitting the same draft retains its UUID, changed input does not", () => {
	const msg = requestFor("hello", null);
	assert.equal(requestFor("hello", msg).id, msg.id);
	assert.notEqual(requestFor("new", msg).id, msg.id);
});
test("keep polling until a reply is recorded", () => {
	for (const state of ["queued", "reserved", "accepted", "unknown", "answered"])
		assert.equal(pending([{ state }]), state !== "answered");
});
