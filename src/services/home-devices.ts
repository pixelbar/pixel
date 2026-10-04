import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import type { Tier } from "../core/access.ts";
import type { Home } from "../core/home.ts";
import type { HomeKind, KindAction } from "../core/home-kinds/index.ts";

/**
 * The allow-list of Home Assistant devices Pixel may touch, from
 * `config/home-assistant/devices.yaml`. Pixel never offers "any entity": the token
 * can do anything, so this list is the fence. Each device has a name people type,
 * an entity, a *kind* (defined in code, which decides what can be done and how),
 * the actions allowed, and who may use it.
 *
 * Fails closed, like the access files: any problem throws, and Pixel refuses to
 * start. Error messages name the file, the position and the field, never a value:
 * the file describes the building.
 */

export const DEVICES_FILE = "devices.yaml";
export const MAX_DEVICES = 200;

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENTITY = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

/** Guests are never allowed, so a device can't be opened to them. */
export type HomeDeviceTier = Exclude<Tier, "guest">;

export type HomeDevice = {
	/** What people type, such as "front-door". */
	name: string;
	/** The Home Assistant entity, such as "lock.front_door". */
	entityId: string;
	kind: HomeKind;
	/** The actions allowed on it: a subset of the kind's. Empty means read-only. */
	actions: readonly KindAction[];
	description?: string;
	/** The lowest tier that may use it (and still needs the capability to act). */
	minTier: HomeDeviceTier;
};

export type HomeDevicesView = {
	readonly devices: readonly HomeDevice[];
	readonly byName: ReadonlyMap<string, HomeDevice>;
};

export class HomeDevicesError extends Error {
	override name = "HomeDevicesError";
}

const EMPTY: HomeDevicesView = { devices: [], byName: new Map() };

function schemaFor(kinds: ReadonlyMap<string, HomeKind>) {
	const kindNames = [...kinds.keys()];
	const device = z
		.strictObject({
			name: z.string({ error: "must be a string" }).regex(NAME, {
				error: "must be lowercase words joined by '-', up to 32 characters, such as front-door",
			}),
			entity: z
				.string({ error: "must be a string" })
				.regex(ENTITY, { error: "must look like light.workshop" }),
			kind: z
				.string({ error: "must be a string" })
				.refine((kind) => kinds.has(kind), { error: `must be one of: ${kindNames.join(", ")}` }),
			// Nothing is allowed unless it's listed, so leaving it out means read-only.
			actions: z
				.array(z.string({ error: "must be a string" }))
				.max(20)
				.optional(),
			description: z.string().trim().min(1).max(100).optional(),
			minTier: z.enum(["friend", "member", "admin"]).optional(),
		})
		.superRefine((d, ctx) => {
			const kind = kinds.get(d.kind);
			if (!kind) return;
			const domain = d.entity.slice(0, d.entity.indexOf("."));
			if (!kind.domains.includes(domain)) {
				ctx.addIssue({
					code: "custom",
					path: ["entity"],
					message: "its domain doesn't match the kind",
				});
			}
			const offered = new Set(kind.actions.map((a) => a.name));
			const actions = d.actions ?? [];
			actions.forEach((action, index) => {
				if (!offered.has(action)) {
					ctx.addIssue({
						code: "custom",
						path: ["actions", index],
						message: "isn't an action this kind offers",
					});
				}
			});
			if (new Set(actions).size !== actions.length) {
				ctx.addIssue({ code: "custom", path: ["actions"], message: "must not repeat an action" });
			}
		});
	return z.strictObject({
		devices: z.array(device).max(MAX_DEVICES, { error: `at most ${MAX_DEVICES} devices` }),
	});
}

/**
 * Reads and checks `<dir>/devices.yaml`. Throws `HomeDevicesError` on any problem,
 * with a message that never includes a value from the file.
 */
export function loadHomeDevices(
	dir: string,
	kinds: ReadonlyMap<string, HomeKind>,
): HomeDevicesView {
	const file = join(dir, DEVICES_FILE);
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
		throw new HomeDevicesError(`${file}: cannot read file (${code})`);
	}

	let data: unknown;
	try {
		data = parse(source);
	} catch (error) {
		// YAML errors quote the offending line; report the position only.
		const pos = error instanceof YAMLParseError ? error.linePos?.[0] : undefined;
		const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
		throw new HomeDevicesError(`${file}: invalid YAML${where}`);
	}

	const result = schemaFor(kinds).safeParse(data);
	if (!result.success) {
		const problems = result.error.issues.map(
			(issue) => `  - ${formatPath(issue.path)}: ${issue.message}`,
		);
		throw new HomeDevicesError(`${file}: invalid devices file\n${problems.join("\n")}`);
	}

	const parsed = result.data.devices;
	assertUnique(
		parsed.map((d) => d.name),
		file,
		"name",
	);
	assertUnique(
		parsed.map((d) => d.entity),
		file,
		"entity",
	);

	const devices = parsed.map((d): HomeDevice => {
		const kind = kinds.get(d.kind) as HomeKind; // checked by the schema
		const wanted = new Set(d.actions ?? []);
		return {
			name: d.name,
			entityId: d.entity,
			kind,
			actions: kind.actions.filter((action) => wanted.has(action.name)),
			...(d.description !== undefined ? { description: d.description } : {}),
			minTier: d.minTier ?? "member",
		};
	});
	return { devices, byName: new Map(devices.map((d) => [d.name, d])) };
}

function assertUnique(values: readonly string[], file: string, field: string): void {
	const first = new Map<string, number>();
	values.forEach((value, index) => {
		const seen = first.get(value);
		if (seen !== undefined) {
			throw new HomeDevicesError(
				`${file}: devices[${index}].${field} duplicates devices[${seen}].${field}`,
			);
		}
		first.set(value, index);
	});
}

function formatPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "(root)";
	return path
		.map((part, i) =>
			typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`,
		)
		.join("");
}

export type HomeDeviceStoreOptions = {
	/** The directory holding `devices.yaml` (`config/home-assistant` by default). */
	dir: string;
	kinds: ReadonlyMap<string, HomeKind>;
};

/**
 * The devices Pixel currently allows. The view is replaced as a whole, and only
 * after a new file has loaded and checked cleanly, so a bad edit never leaves
 * Pixel with a half-loaded or empty list.
 */
export class HomeDeviceStore {
	readonly #options: HomeDeviceStoreOptions | undefined;
	#view: HomeDevicesView;

	private constructor(options: HomeDeviceStoreOptions | undefined, view: HomeDevicesView) {
		this.#options = options;
		this.#view = view;
	}

	/** For when Home Assistant isn't configured: no devices, and nothing to reload. */
	static empty(): HomeDeviceStore {
		return new HomeDeviceStore(undefined, EMPTY);
	}

	/** Loads the file. Throws `HomeDevicesError` if it's missing or invalid, so startup fails closed. */
	static open(options: HomeDeviceStoreOptions): HomeDeviceStore {
		return new HomeDeviceStore(options, loadHomeDevices(options.dir, options.kinds));
	}

	/** Whether Home Assistant is set up, and so a devices file is expected. */
	get configured(): boolean {
		return this.#options !== undefined;
	}

	get view(): HomeDevicesView {
		return this.#view;
	}

	/** Re-reads the file. If it's now invalid this throws and the old list stays. */
	reload(): { before: number; after: number } {
		const before = this.#view.devices.length;
		if (!this.#options) return { before, after: before };
		this.#view = loadHomeDevices(this.#options.dir, this.#options.kinds);
		return { before, after: this.#view.devices.length };
	}
}

/**
 * Names of devices whose entity Home Assistant doesn't know, so a typo in the
 * file shows up as a warning. Undefined when it couldn't be checked (Home
 * Assistant is unreachable), which is not a problem with the file.
 */
export async function findMissingDevices(
	view: HomeDevicesView,
	home: Pick<Home, "getStates">,
): Promise<string[] | undefined> {
	if (view.devices.length === 0) return [];
	try {
		const found = await home.getStates(view.devices.map((d) => d.entityId));
		return view.devices.filter((d) => !found.has(d.entityId)).map((d) => d.name);
	} catch {
		return undefined;
	}
}
