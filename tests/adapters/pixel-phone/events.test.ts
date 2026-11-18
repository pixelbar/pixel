import { describe, expect, it } from "vitest";
import { parseMessage } from "../../../src/adapters/pixel-phone/events.ts";

// The examples in pixel-phone's docs/events.md, contract v1. The numbers are made up.
const CALL = "20261118-3f9a1c2b7d4e";
const WHO = { version: 1, callId: CALL, from: "+31201234567", to: "+31103024128" };
const json = (value: unknown) => JSON.stringify(value);

describe("parseMessage", () => {
	it("reads ringing, with when it can still be accepted", () => {
		expect(
			parseMessage(
				json({
					...WHO,
					type: "ringing",
					occurredAt: "2026-11-18T09:00:00.000Z",
					acceptBy: "2026-11-18T09:00:15.000Z",
				}),
			),
		).toEqual({
			ok: true,
			event: {
				type: "ringing",
				callId: CALL,
				occurredAt: new Date("2026-11-18T09:00:00Z"),
				acceptBy: new Date("2026-11-18T09:00:15Z"),
			},
		});
	});

	it("reads accepted, with who accepted when it says", () => {
		const at = "2026-11-18T09:00:06.120Z";
		expect(
			parseMessage(
				json({ ...WHO, type: "accepted", occurredAt: at, via: "pixel", by: "discord:1234" }),
			),
		).toEqual({
			ok: true,
			event: {
				type: "accepted",
				callId: CALL,
				occurredAt: new Date(at),
				via: "pixel",
				by: "discord:1234",
			},
		});
		expect(
			parseMessage(json({ ...WHO, type: "accepted", occurredAt: at, via: "home-assistant" })),
		).toEqual({
			ok: true,
			event: { type: "accepted", callId: CALL, occurredAt: new Date(at), via: "home-assistant" },
		});
	});

	it("reads missed, busy and ended", () => {
		const at = "2026-11-18T09:00:15.004+01:00";
		expect(
			parseMessage(json({ ...WHO, type: "missed", occurredAt: at, reason: "timeout" })),
		).toEqual({
			ok: true,
			event: { type: "missed", callId: CALL, occurredAt: new Date(at), reason: "timeout" },
		});
		expect(
			parseMessage(
				json({ ...WHO, type: "busy", occurredAt: at, activeCallId: "20261118-0a1b2c3d4e5f" }),
			),
		).toMatchObject({ ok: true, event: { type: "busy", activeCallId: "20261118-0a1b2c3d4e5f" } });
		expect(
			parseMessage(json({ ...WHO, type: "ended", occurredAt: at, reason: "abandoned" })),
		).toMatchObject({ ok: true, event: { type: "ended", reason: "abandoned" } });
	});

	it("keeps no phone numbers", () => {
		const parsed = parseMessage(
			json({ ...WHO, type: "missed", occurredAt: "2026-11-18T09:00:15Z", reason: "timeout" }),
		);
		expect(JSON.stringify(parsed)).not.toContain("+31");
	});

	it("ignores fields it doesn't know, so pixel-phone can add some", () => {
		expect(
			parseMessage(
				json({
					...WHO,
					type: "missed",
					occurredAt: "2026-11-18T09:00:15Z",
					reason: "timeout",
					somethingNew: true,
				}),
			),
		).toMatchObject({ ok: true, event: { type: "missed" } });
	});

	it.each([
		["not JSON", "{", "json"],
		["not an object", json([1, 2]), "json"],
		["null", "null", "json"],
		["no version", json({ callId: CALL, type: "missed" }), "version"],
		["version 2", json({ ...WHO, version: 2, type: "rang" }), "version"],
		["the version as text", json({ ...WHO, version: "1", type: "missed" }), "version"],
		[
			"an unknown type",
			json({ ...WHO, type: "rang", occurredAt: "2026-11-18T09:00:00Z" }),
			"invalid",
		],
		[
			"a bad call ID",
			json({
				...WHO,
				callId: "../x",
				type: "missed",
				occurredAt: "2026-11-18T09:00:00Z",
				reason: "timeout",
			}),
			"invalid",
		],
		[
			"a time that isn't one",
			json({ ...WHO, type: "missed", occurredAt: "yesterday", reason: "timeout" }),
			"invalid",
		],
		[
			"ringing without acceptBy",
			json({ ...WHO, type: "ringing", occurredAt: "2026-11-18T09:00:00Z" }),
			"invalid",
		],
		[
			"an unknown reason",
			json({ ...WHO, type: "missed", occurredAt: "2026-11-18T09:00:00Z", reason: "bored" }),
			"invalid",
		],
		["something huge", json({ ...WHO, type: "missed", padding: "x".repeat(5000) }), "invalid"],
	])("refuses %s", (_label, text, why) => {
		expect(parseMessage(text)).toEqual({ ok: false, why });
	});
});
