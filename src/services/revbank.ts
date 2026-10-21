import { z } from "zod";
import { type Revbank, RevbankError } from "../core/ports/revbank.ts";

const cents = z.number().int().safe();
const instant = z.iso.datetime({ offset: true });
const link = z.discriminatedUnion("state", [
	z.object({ state: z.literal("unlinked") }).strict(),
	z.object({ state: z.literal("linked"), nick: z.string().min(1).max(64) }).strict(),
	z
		.object({
			state: z.literal("pending"),
			nick: z.string().min(1).max(64),
			requestId: z.uuid(),
			expiresAt: instant,
		})
		.strict(),
]);
const balance = z.object({ balanceCents: cents, updatedAt: instant }).strict();
const history = z
	.object({
		updatedAt: instant,
		transactions: z
			.array(
				z
					.object({
						id: z.string().regex(/^\d{1,20}$/),
						at: instant,
						amountCents: cents,
						balanceCents: cents,
						description: z.string().min(1).max(200),
					})
					.strict(),
			)
			.max(10),
	})
	.strict();
const empty = z.object({}).strict();

/** All requests are bounded, private POSTs. No redirects, retries or response logging. */
export class HttpRevbank implements Revbank {
	readonly #fetch: typeof globalThis.fetch;
	constructor(
		private readonly options: { url: string; token: string; fetch?: typeof globalThis.fetch },
	) {
		this.#fetch = options.fetch ?? globalThis.fetch;
	}
	status(actor: string) {
		return this.#call("status", { actor }, link);
	}
	request(actor: string, nick: string) {
		return this.#call("link", { actor, nick }, link);
	}
	async unlink(actor: string) {
		await this.#call("unlink", { actor }, empty);
	}
	balance(actor: string) {
		return this.#call("balance", { actor }, balance);
	}
	history(actor: string) {
		return this.#call("transactions", { actor }, history);
	}
	review(actor: string, target: string) {
		return this.#call("review", { actor, target }, link);
	}
	async decide(actor: string, target: string, requestId: string, approve: boolean) {
		await this.#call(approve ? "approve" : "reject", { actor, target, requestId }, empty);
	}
	async revoke(actor: string, target: string) {
		await this.#call("revoke", { actor, target }, empty);
	}

	async #call<T>(operation: string, body: object, schema: z.ZodType<T>): Promise<T> {
		try {
			const response = await this.#fetch(new URL(`/v1/${operation}`, this.options.url), {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(8_000),
				headers: {
					authorization: `Bearer ${this.options.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new RevbankError(
					response.status === 403
						? "denied"
						: response.status === 404
							? "not-linked"
							: response.status === 409
								? "conflict"
								: "unavailable",
				);
			}
			if (!response.body) throw new RevbankError("unavailable");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 16_384) throw new RevbankError("unavailable");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		} catch (error) {
			if (error instanceof RevbankError) throw error;
			throw new RevbankError("unavailable");
		}
	}
}
