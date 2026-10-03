import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/testing/**"],
			reporter: ["text", "html"],
			// `just check` fails below these. The overall floor is lower because
			// entry points (src/index.ts, src/instrument.ts) and the discord.js
			// client wiring (adapters/discord/index.ts) are verified by running the
			// bot, not by unit tests. Security-relevant code gets strict floors.
			thresholds: {
				lines: 80,
				statements: 80,
				functions: 75,
				branches: 85,
				// functions < 100 only because of no-op stand-ins (silentLogger, nullErrorReporter)
				"src/core/**": { lines: 98, statements: 98, functions: 90, branches: 95 },
				"src/services/**": { lines: 98, statements: 98, functions: 98, branches: 85 },
				"src/features/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
				"src/adapters/discord/{args,commands,handlers,render,respond,announce-render,announce-publishers,announce-state,calendar-map}.ts":
					{
						lines: 98,
						statements: 98,
						functions: 98,
						branches: 85,
					},
				"src/observability/{scrub,sentry-reporter,health}.ts": {
					lines: 98,
					statements: 98,
					functions: 98,
					branches: 90,
				},
			},
		},
	},
});
