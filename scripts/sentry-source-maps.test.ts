import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const justfile = readFileSync("justfile", "utf8");

/** The runtime stage's CMD, as the argument list Docker runs. */
function runtimeCmd(): string[] {
	const line = dockerfile
		.split("\n")
		.filter((l) => l.startsWith("CMD "))
		.at(-1);
	if (!line) throw new Error("Dockerfile has no CMD");
	return JSON.parse(line.slice("CMD ".length)) as string[];
}

// Sentry gets source maps uploaded for the compiled files in /app/dist (CD, the
// Release workflow and `just sentry-release`). They only apply if the frames Sentry
// receives still point at /app/dist/*.js.
describe("Sentry source maps", () => {
	it("leaves stack frames on dist/*.js in the image so the uploaded maps apply", () => {
		// --enable-source-maps rewrites frames to /app/src/*.ts before Sentry sees
		// them, which matches no uploaded artifact and has no source in the image.
		expect(runtimeCmd()).not.toContain("--enable-source-maps");
		expect(dockerfile).not.toMatch(/NODE_OPTIONS=.*--enable-source-maps/);
	});

	it("runs the compiled files from the path the maps are uploaded for", () => {
		expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
		expect(runtimeCmd()).toContain("dist/index.js");
		expect(justfile).toContain("--url-prefix /app/dist dist");
	});
});
