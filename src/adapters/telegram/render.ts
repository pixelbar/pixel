import type { Embed, Reply } from "../../core/reply.ts";

/**
 * Telegram shows HTML, not the markdown the core writes (which is Discord's flavour:
 * `**bold**`, `` `code` ``, `[text](url)` and `\` escapes). This converts that small
 * subset to Telegram HTML, escaping everything else, so nothing anyone else wrote
 * (an event title, a Home Assistant state) can become formatting or a link it
 * shouldn't. Embeds become a bold title, the description and one line per field.
 */

/** Telegram's limit for a message. */
const MESSAGE_LIMIT = 4096;

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Rewrites "/ha set" to "/ha_set" (longest names first), so replies that mention a
 * command name the one Telegram people can actually tap.
 */
export function rewriteCommandNames(text: string, names: ReadonlyMap<string, string>): string {
	let out = text;
	const byLength = [...names.entries()].sort((a, b) => b[0].length - a[0].length);
	for (const [coreName, telegramName] of byLength) {
		if (coreName === telegramName) continue;
		out = out.split(`/${coreName}`).join(`/${telegramName}`);
	}
	return out;
}

/** Converts the core's markdown to Telegram HTML. */
export function markdownToHtml(markdown: string): string {
	let out = "";
	let bold = false;
	let i = 0;
	while (i < markdown.length) {
		const ch = markdown[i] as string;
		if (ch === "\\" && i + 1 < markdown.length) {
			out += escapeHtml(markdown[i + 1] as string);
			i += 2;
			continue;
		}
		if (ch === "`") {
			const end = markdown.indexOf("`", i + 1);
			if (end > i) {
				out += `<code>${escapeHtml(markdown.slice(i + 1, end))}</code>`;
				i = end + 1;
				continue;
			}
		}
		if (markdown.startsWith("**", i)) {
			out += bold ? "</b>" : "<b>";
			bold = !bold;
			i += 2;
			continue;
		}
		if (ch === "[") {
			const link = /^\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/.exec(markdown.slice(i));
			if (link) {
				out += `<a href="${escapeHtml(link[2] as string)}">${escapeHtml(link[1] as string)}</a>`;
				i += link[0].length;
				continue;
			}
		}
		out += escapeHtml(ch);
		i += 1;
	}
	if (bold) out += "</b>";
	return out;
}

function renderEmbed(embed: Embed): string {
	const parts = [`<b>${markdownToHtml(embed.title)}</b>`];
	if (embed.description) parts.push(markdownToHtml(embed.description));
	const fields = (embed.fields ?? []).map((field) => {
		const name = markdownToHtml(field.name);
		const value = markdownToHtml(field.value);
		return value.includes("\n") ? `<b>${name}</b>\n${value}` : `<b>${name}:</b> ${value}`;
	});
	if (fields.length > 0) parts.push(fields.join("\n"));
	if (embed.url) parts.push(`<a href="${escapeHtml(embed.url)}">Open</a>`);
	return parts.join("\n\n");
}

/** The whole reply as one Telegram HTML message, within Telegram's length limit. */
export function renderReply(reply: Reply, names: ReadonlyMap<string, string> = new Map()): string {
	const rewrite = (text: string) => rewriteCommandNames(text, names);
	const blocks = [
		...(reply.text ? [markdownToHtml(rewrite(reply.text))] : []),
		...(reply.embeds ?? []).map((embed) =>
			renderEmbed({
				...embed,
				title: rewrite(embed.title),
				...(embed.description ? { description: rewrite(embed.description) } : {}),
				...(embed.fields
					? { fields: embed.fields.map((f) => ({ ...f, value: rewrite(f.value) })) }
					: {}),
			}),
		),
	];
	const html = blocks.length > 0 ? blocks.join("\n\n") : "Done.";
	return truncateHtml(html);
}

/** Cuts a too-long message at a line break, so no tag is left open. */
function truncateHtml(html: string): string {
	if (html.length <= MESSAGE_LIMIT) return html;
	const cut = html.lastIndexOf("\n", MESSAGE_LIMIT - 20);
	return `${html.slice(0, cut > 0 ? cut : 0)}\n…`;
}
