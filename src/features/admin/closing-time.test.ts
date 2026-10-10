import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserFacingError } from "../../core/errors.ts";
import { silentLogger } from "../../core/logger.ts";
import { context, IDS, principal } from "../../testing/fixtures.ts";
import { closingTimeMessage } from "../closing-time/index.ts";
import { createSetSubgroup } from "./closing-time.ts";

describe("/admin set closing-time", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function setup() {
		dir = mkdtempSync(join(tmpdir(), "pixel-admin-closing-"));
		const file = join(dir, "data", "closing-time.md");
		const group = createSetSubgroup({ closingTimeFile: file });
		const command = group.subcommands[0];
		if (!command) throw new Error("no closing-time subcommand");
		return { file, group, command };
	}

	it("is an admin-only private form command", () => {
		const { group, command } = setup();
		expect(group.name).toBe("set");
		expect(group.access.minTier).toBe("admin");
		expect(command.name).toBe("closing-time");
		expect(command.access.minTier).toBe("admin");
		expect(command.private).toBe(true);
		expect(command.options?.[0]).toMatchObject({
			name: "message",
			type: "string",
			required: true,
			form: { style: "paragraph", maxLength: 4000 },
		});
	});

	it("writes the message to the persist file", async () => {
		const { file, command } = setup();
		const reply = await command.handler(
			context({
				principal: principal("admin", { userId: IDS.admin }),
				args: { message: "Please tidy the kitchen.\nLast out locks the door." },
			}),
		);
		expect(reply).toEqual({ text: "Saved the closing-time message.", private: true });
		expect(readFileSync(file, "utf8")).toBe("Please tidy the kitchen.\nLast out locks the door.\n");
		expect(closingTimeMessage(file, silentLogger)()).toBe(
			"Please tidy the kitchen.\nLast out locks the door.",
		);
	});

	it("says so when the persist file can't be written", async () => {
		setup();
		const blocked = join(dir, "blocked");
		writeFileSync(blocked, "not a directory");
		const group = createSetSubgroup({ closingTimeFile: join(blocked, "closing-time.md") });
		const broken = group.subcommands[0];
		if (!broken) throw new Error("no command");
		await expect(
			broken.handler(
				context({
					principal: principal("admin", { userId: IDS.admin }),
					args: { message: "Please tidy up." },
				}),
			),
		).rejects.toThrow(/Couldn't save the closing-time message/);
	});

	it("refuses an empty message without creating the file", async () => {
		const { file, command } = setup();
		await expect(
			command.handler(
				context({
					principal: principal("admin", { userId: IDS.admin }),
					args: { message: "   " },
				}),
			),
		).rejects.toThrow(UserFacingError);
		expect(() => readFileSync(file)).toThrow(/ENOENT/);
	});
});
