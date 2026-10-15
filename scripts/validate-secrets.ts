/**
 * Validates infra/secrets.manifest.yaml and lists what it declares. Names only:
 * this never reads a secret value, and needs no Azure login.
 * Usage: just validate-secrets
 */
import { loadSecretsManifest, MANIFEST_FILE, SecretsManifestError } from "./secrets-manifest.ts";

try {
	const { secrets } = loadSecretsManifest(process.argv[2] ?? MANIFEST_FILE);
	const rows = secrets.map((s) => [s.vault, s.group, s.delivery, s.feature, s.env ?? "-"]);
	const header = ["vault", "group", "delivery", "feature", "env"];
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: readonly string[]) =>
		`${cells
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd()}\n`;
	process.stdout.write(line(header));
	for (const row of rows) process.stdout.write(line(row));
	const app = secrets.filter((s) => s.group === "app").length;
	process.stdout.write(
		`OK: ${secrets.length} secrets (${app} app, ${secrets.length - app} infra)\n`,
	);
} catch (error) {
	if (!(error instanceof SecretsManifestError)) throw error;
	process.stderr.write(`${error.message}\n`);
	process.exit(1);
}
