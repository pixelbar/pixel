import { describe, expect, it, vi } from "vitest";
import type { PlatformActor } from "../../core/access.ts";
import type { Logger } from "../../core/logger.ts";
import { IDS } from "../../testing/fixtures.ts";
import {
	classifyInteractionError,
	handleInteractionFailure,
	SlowAcknowledgementError,
} from "./interaction-errors.ts";

describe("classifyInteractionError", () => {
	it("calls Discord 40060 (already acknowledged) a duplicate", () => {
		expect(classifyInteractionError({ code: 40060 })).toBe("duplicate");
		expect(classifyInteractionError({ code: "40060" })).toBe("duplicate");
	});

	it("calls Discord 10062 (unknown interaction) expired, not a duplicate", () => {
		expect(classifyInteractionError({ code: 10062 })).toBe("expired");
		expect(classifyInteractionError({ code: "10062" })).toBe("expired");
	});

	it("leaves other errors alone", () => {
		expect(classifyInteractionError(undefined)).toBe("other");
		expect(classifyInteractionError(null)).toBe("other");
		expect(classifyInteractionError("already acknowledged")).toBe("other");
		expect(classifyInteractionError({ message: "Unknown interaction" })).toBe("other");
		expect(classifyInteractionError({ code: 50013 })).toBe("other");
		expect(classifyInteractionError(new Error("boom"))).toBe("other");
	});
});

describe("handleInteractionFailure", () => {
	const actor: PlatformActor = {
		platform: "discord",
		userId: IDS.member,
		displayName: "Member",
		handle: "member_handle",
		chat: "group",
	};
	const who = { user: `discord:${IDS.member}`, userName: "Member", userHandle: "member_handle" };

	function setup() {
		const logger = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			child: vi.fn(),
		} satisfies Logger;
		const reportError = vi.fn();
		return { logger, reportError };
	}

	const discordError = (code: number) => Object.assign(new Error(`discord ${code}`), { code });

	it("warns about a second instance on 40060, without reporting it", () => {
		const deps = setup();
		const error = discordError(40060);
		handleInteractionFailure(error, deps, { actor, command: "status" });
		expect(deps.logger.warn).toHaveBeenCalledWith(
			{ err: error, command: "status", ...who, event: "discord.duplicate_handler" },
			expect.stringContaining("second instance"),
		);
		expect(deps.logger.error).not.toHaveBeenCalled();
		expect(deps.reportError).not.toHaveBeenCalled();
	});

	it("says form for a duplicate form submission", () => {
		const deps = setup();
		handleInteractionFailure(discordError(40060), deps, { actor });
		expect(deps.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "discord.duplicate_handler" }),
			expect.stringContaining("this form"),
		);
		expect(deps.logger.warn.mock.calls[0]?.[0]).not.toHaveProperty("command");
	});

	it("reports 10062 as a slow acknowledgement of the command, not a second instance", () => {
		const deps = setup();
		const error = discordError(10062);
		handleInteractionFailure(error, deps, { actor, command: "ha" });
		expect(deps.logger.warn).not.toHaveBeenCalled();
		expect(deps.logger.error).toHaveBeenCalledWith(
			{ err: error, command: "ha", ...who, event: "discord.slow_ack" },
			expect.not.stringContaining("second instance"),
		);
		const [reported, reportedActor] = deps.reportError.mock.calls[0] ?? [];
		expect(reported).toBeInstanceOf(SlowAcknowledgementError);
		expect((reported as Error).message).toContain("/ha");
		expect((reported as Error).cause).toBe(error);
		expect(reportedActor).toBe(actor);
	});

	it("names a form when a slow form submission expires", () => {
		const deps = setup();
		handleInteractionFailure(discordError(10062), deps, { actor });
		expect(deps.reportError).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("a form") }),
			actor,
		);
	});

	it("logs and reports anything else with who it happened to", () => {
		const deps = setup();
		const error = new Error("boom");
		handleInteractionFailure(error, deps, { actor, command: "status" });
		expect(deps.logger.error).toHaveBeenCalledWith(
			{ err: error, command: "status", ...who },
			"failed to handle interaction",
		);
		expect(deps.reportError).toHaveBeenCalledWith(error, actor);

		handleInteractionFailure(error, deps, { actor });
		expect(deps.logger.error).toHaveBeenLastCalledWith(
			{ err: error, ...who },
			"failed to handle a form",
		);
	});
});
