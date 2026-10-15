/**
 * Loads and validates `infra/secrets.manifest.yaml`: the list of secrets Pixel's hosting
 * keeps in Azure Key Vault. Names and metadata only; values never pass through here.
 * Used by `just validate-secrets` and `just secrets-pull` / `secrets-push`. See ADRs 0015 and 0016.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const MANIFEST_FILE = "infra/secrets.manifest.yaml";

/** Azure Key Vault secret names: letters, digits and dashes, up to 127. Kept lowercase here. */
const vaultName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}$/, {
	error: "must be lowercase letters, digits and dashes (a Key Vault secret name)",
});
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
	error: "must be an environment variable name like DISCORD_TOKEN",
});
const featureName = z.string().regex(/^[a-z][a-z0-9-]*$/, {
	error: "must be lowercase words joined by dashes",
});
const description = z.string().trim().min(1).max(200);

export const GROUPS = ["app", "infra", "tooling"] as const;
export const DELIVERIES = ["env", "file", "sidecar-env", "registry", "tool"] as const;

const entrySchema = z.strictObject({
	vault: vaultName,
	group: z.enum(GROUPS),
	delivery: z.enum(DELIVERIES),
	env: envName.optional(),
	feature: featureName,
	description,
});

const manifestSchema = z.strictObject({
	version: z.literal(1),
	features: z.record(featureName, description),
	secrets: z.array(entrySchema).min(1),
});

export type SecretEntry = z.infer<typeof entrySchema>;
export type SecretGroup = (typeof GROUPS)[number];
export type SecretDelivery = (typeof DELIVERIES)[number];
export type SecretsManifest = {
	features: Readonly<Record<string, string>>;
	secrets: readonly SecretEntry[];
};

export class SecretsManifestError extends Error {
	override name = "SecretsManifestError";
}

/** Whether a delivery names an environment variable. */
const NEEDS_ENV: ReadonlySet<SecretDelivery> = new Set(["env", "sidecar-env"]);

/**
 * Parses the manifest text. Every problem is collected into one error, and none of
 * them echoes a value from the file beyond the secret's own name.
 */
export function parseSecretsManifest(source: string, file = MANIFEST_FILE): SecretsManifest {
	let data: unknown;
	try {
		data = parse(source);
	} catch {
		throw new SecretsManifestError(`${file} is not valid YAML`);
	}
	const result = manifestSchema.safeParse(data);
	if (!result.success) {
		const problems = result.error.issues.map(
			(i) => `  - ${i.path.join(".") || "(file)"}: ${i.message}`,
		);
		throw new SecretsManifestError(`${file} is invalid:\n${problems.join("\n")}`);
	}

	const { features, secrets } = result.data;
	const problems: string[] = [];
	const vaults = new Set<string>();
	const envs = new Set<string>();

	for (const secret of secrets) {
		const label = `"${secret.vault}"`;
		if (vaults.has(secret.vault)) problems.push(`${label} is listed twice`);
		vaults.add(secret.vault);

		if (NEEDS_ENV.has(secret.delivery) && !secret.env) {
			problems.push(`${label} is delivered as ${secret.delivery}, so it needs an env`);
		}
		if (!NEEDS_ENV.has(secret.delivery) && secret.env) {
			problems.push(`${label} is delivered as ${secret.delivery}, so it has no env`);
		}
		if (secret.env) {
			if (envs.has(secret.env)) problems.push(`${label} reuses the env ${secret.env}`);
			envs.add(secret.env);
		}
		if (secret.feature !== "always" && !(secret.feature in features)) {
			problems.push(`${label} uses the feature "${secret.feature}", which isn't declared`);
		}
		// The Pixel app only ever sees env and file secrets. Anything else belongs to the platform.
		if (secret.group === "app" && !(secret.delivery === "env" || secret.delivery === "file")) {
			problems.push(`${label} is in the app group but is delivered as ${secret.delivery}`);
		}
		// Only the laptop tools read tooling secrets; Terraform skips the group entirely.
		if ((secret.group === "tooling") !== (secret.delivery === "tool")) {
			problems.push(`${label}: the tooling group and the tool delivery go together`);
		}
	}
	if (!("always" in features)) problems.push(`the feature "always" must be declared`);

	if (problems.length > 0) {
		throw new SecretsManifestError(
			`${file} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
	}
	return { features, secrets };
}

export function loadSecretsManifest(file = MANIFEST_FILE): SecretsManifest {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new SecretsManifestError(`cannot read ${file} (${code})`);
	}
	return parseSecretsManifest(source, file);
}

/** The secrets Terraform knows about: everything but the tooling group. */
export function terraformSecrets(manifest: SecretsManifest): SecretEntry[] {
	return manifest.secrets.filter((s) => s.group !== "tooling");
}

/**
 * The secrets Terraform may write (write_secrets): the infra group only. The app group is
 * written by just secrets-push / just push alone (ADR 0017).
 */
export function terraformWrittenSecrets(manifest: SecretsManifest): SecretEntry[] {
	return manifest.secrets.filter((s) => s.group === "infra");
}

/** The secrets a stack needs, given which features it turns on. `always` is implied. */
export function enabledSecrets(
	manifest: SecretsManifest,
	features: ReadonlySet<string>,
): SecretEntry[] {
	return terraformSecrets(manifest).filter(
		(s) => s.feature === "always" || features.has(s.feature),
	);
}

/** Environment variable → Key Vault name, for the secrets the app reads from its environment. */
export function appEnvSecrets(entries: readonly SecretEntry[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		if (entry.delivery === "env" && entry.env) out[entry.env] = entry.vault;
	}
	return out;
}
