/**
 * Shows Pixel's admin-tier commands to the people in config/admins.yaml.
 * Usage: just command-access   (run `just register` first)
 *
 * Discord only lets a *user* change command permissions, so this walks you
 * through a one-off sign-in: it prints a link, you approve it as someone who
 * manages the server, and Discord sends the token back to a short-lived page on
 * localhost. The token stays in memory. It is never printed, logged or saved.
 *
 * One-time setup: add http://localhost:53682/callback under OAuth2 → Redirects
 * for the app in the Discord Developer Portal.
 *
 * This only changes what people *see*. The dispatcher still decides who may run
 * a command. It replaces each hidden command's existing overrides.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { REST, Routes } from "discord.js";
import {
	adminOverrides,
	authorizeUrl,
	hiddenCommandNames,
	parseGrant,
} from "../src/adapters/discord/command-access.ts";
import { buildCore } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/core/logger.ts";
import { nullErrorReporter } from "../src/core/ports/error-reporter.ts";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TIMEOUT_MS = 5 * 60_000;

const config = loadConfig();
const { registry, access } = buildCore(config, silentLogger, nullErrorReporter);
const names = hiddenCommandNames(registry.all().map((c) => c.definition));
const overrides = adminOverrides(access.discord);
const { appId, guildId } = config.discord;

const state = randomBytes(16).toString("hex");

// The token arrives in the URL fragment, which browsers don't send to servers,
// so the page forwards it to us with a POST.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Pixel</title>
<p id="m">Finishing up…</p>
<script>
fetch("/token", { method: "POST", body: location.hash.slice(1) })
  .then((r) => { document.getElementById("m").textContent = r.ok ? "Done. You can close this tab." : "Something went wrong. Check the terminal."; history.replaceState(null, "", "/callback"); })
  .catch(() => { document.getElementById("m").textContent = "Something went wrong. Check the terminal."; });
</script>`;

function waitForToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			if (req.method === "GET" && req.url?.startsWith("/callback")) {
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				});
				res.end(PAGE);
			} else if (req.method === "POST" && req.url === "/token") {
				let body = "";
				req.on("data", (chunk) => {
					body += chunk;
					if (body.length > 4096) req.destroy();
				});
				req.on("end", () => {
					try {
						const token = parseGrant(body, state);
						res.writeHead(204).end();
						server.close();
						clearTimeout(timer);
						resolve(token);
					} catch (error) {
						res.writeHead(400).end();
						server.close();
						clearTimeout(timer);
						reject(error);
					}
				});
			} else {
				res.writeHead(404).end();
			}
		});
		const timer = setTimeout(() => {
			server.close();
			reject(new Error("Timed out waiting for the sign-in"));
		}, TIMEOUT_MS);
		server.listen(PORT, "127.0.0.1", () => {
			process.stdout.write(
				`Open this link as someone who manages the server, and approve it:\n\n${authorizeUrl({ appId, redirectUri: REDIRECT_URI, state })}\n\nWaiting for you (5 minutes)…\n`,
			);
		});
		server.on("error", reject);
	});
}

if (names.length === 0) {
	process.stdout.write("No admin-tier commands, nothing to do.\n");
	process.exit(0);
}

const rest = new REST().setToken(config.discord.token);
const registered = (await rest.get(Routes.applicationGuildCommands(appId, guildId))) as {
	id: string;
	name: string;
}[];
const missing = names.filter((n) => !registered.some((c) => c.name === n));
if (missing.length > 0) {
	process.stderr.write(
		`Not registered yet: ${missing.map((n) => `/${n}`).join(", ")}. Run \`just register\` first.\n`,
	);
	process.exit(1);
}

const token = await waitForToken();
const userRest = new REST({ authPrefix: "Bearer" }).setToken(token);
for (const command of registered.filter((c) => names.includes(c.name))) {
	await userRest.put(Routes.applicationCommandPermissions(appId, guildId, command.id), {
		body: { permissions: overrides },
	});
	process.stdout.write(`/${command.name}: visible to ${overrides.length} admin(s)\n`);
}
