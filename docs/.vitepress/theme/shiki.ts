import type { ThemeRegistration } from "vitepress";

/**
 * Syntax colours from the Pixel spectrum. Dark uses the logo's neon values; light
 * uses the deepened values that hold 5:1 on white. Values mirror tokens.json.
 */
type Palette = {
	bg: string;
	ink: string;
	muted: string;
	faint: string;
	cyan: string;
	blue: string;
	violet: string;
	magenta: string;
	red: string;
	orange: string;
	yellow: string;
	green: string;
};

function theme(name: string, type: "dark" | "light", p: Palette): ThemeRegistration {
	return {
		name,
		type,
		colors: { "editor.background": p.bg, "editor.foreground": p.ink },
		tokenColors: [
			{ settings: { foreground: p.ink } },
			{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: p.faint } },
			{
				scope: ["keyword", "storage", "storage.type", "keyword.control", "keyword.operator.new"],
				settings: { foreground: p.magenta },
			},
			{
				scope: ["string", "string.quoted", "markup.inline.raw"],
				settings: { foreground: p.yellow },
			},
			{
				scope: ["constant.numeric", "constant.language", "constant.character", "support.constant"],
				settings: { foreground: p.orange },
			},
			{
				scope: ["entity.name.function", "support.function", "meta.function-call"],
				settings: { foreground: p.cyan },
			},
			{
				scope: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
				settings: { foreground: p.violet },
			},
			{
				scope: [
					"variable.parameter",
					"meta.object-literal.key",
					"support.type.property-name",
					"entity.name.tag.yaml",
				],
				settings: { foreground: p.blue },
			},
			{ scope: ["entity.name.tag", "meta.tag"], settings: { foreground: p.magenta } },
			{ scope: ["entity.other.attribute-name"], settings: { foreground: p.cyan } },
			{ scope: ["variable", "variable.other"], settings: { foreground: p.ink } },
			{
				scope: ["punctuation", "meta.brace", "keyword.operator"],
				settings: { foreground: p.muted },
			},
			{
				scope: ["markup.heading", "markup.bold"],
				settings: { foreground: p.ink, fontStyle: "bold" },
			},
			{ scope: ["markup.inserted"], settings: { foreground: p.green } },
			{ scope: ["markup.deleted", "invalid"], settings: { foreground: p.red } },
			{ scope: ["markup.underline.link"], settings: { foreground: p.cyan } },
		],
	};
}

export const pixelDark = theme("pixel-dark", "dark", {
	bg: "#0e0e18",
	ink: "#f3f3fb",
	muted: "#a6a6c0",
	faint: "#8a8aac",
	cyan: "#00e5ff",
	blue: "#4d7dff",
	violet: "#a855ff",
	magenta: "#ff3dd6",
	red: "#ff4058",
	orange: "#ff8a1f",
	yellow: "#ffe81a",
	green: "#33ff66",
});

export const pixelLight = theme("pixel-light", "light", {
	bg: "#ffffff",
	ink: "#0a0a12",
	muted: "#4d4d66",
	faint: "#5c5c78",
	cyan: "#006b7d",
	blue: "#1d4fd8",
	violet: "#7c1fd6",
	magenta: "#b8128f",
	red: "#c8102e",
	orange: "#9c4c00",
	yellow: "#716000",
	green: "#0d722a",
});
