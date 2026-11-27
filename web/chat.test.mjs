import assert from "node:assert/strict";
import test from "node:test";
import { pending, replyDraft, requestFor } from "./chat.ts";

test("a typed approval never moves to a newer prompt", () => {
	const card = (id) => ({ updates: [{ id, choices: ["session"] }] });
	const started = replyDraft("/", null, [card("first")]);
	assert.equal(
		replyDraft("/approve session", started, [card("second")]).approval,
		"first",
	);
	assert.equal(
		replyDraft("/approve session", null, [card("first"), card("second")])
			.approval,
		undefined,
	);
});

test("resubmitting the same draft retains its UUID, changed input does not", () => {
	const msg = requestFor("hello", null);
	assert.equal(requestFor("hello", msg).id, msg.id);
	assert.notEqual(requestFor("new", msg).id, msg.id);
});
test("keep polling until a reply is recorded", () => {
	for (const state of ["queued", "reserved", "accepted", "unknown", "answered"])
		assert.equal(pending([{ state }]), state !== "answered");
	assert.equal(pending([{ state: "released" }]), false);
	assert.equal(pending([{ state: "released" }, { state: "queued" }]), true);
});
