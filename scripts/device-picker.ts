/**
 * A checkbox list you can search, for `just ha-devices`: Home Assistant has far
 * too many entities to scroll through. The stock inquirer checkbox can't filter,
 * so this is the same idea on `@inquirer/core`, with the key handling in a pure
 * reducer (`pickerReduce`) so it can be tested.
 *
 *   ↑ ↓     move              /      search (type to filter the list)
 *   space   tick or untick    s      show every ticked item (again: show everything)
 *   a       tick every shown  ⏎      while searching: keep the filter and go back to the list
 *   esc     go back                  otherwise: done
 *
 * Esc leaves a search; otherwise it clears the filter and the ticked-only view.
 * Ticks stay when the filter changes, so you can search, tick, search again.
 * Items can start ticked, so unticking one is a choice too.
 */
import { styleText } from "node:util";
import {
	createPrompt,
	isDownKey,
	isEnterKey,
	isSpaceKey,
	isUpKey,
	makeTheme,
	useKeypress,
	usePagination,
	usePrefix,
	useState,
} from "@inquirer/core";

export type PickerItem<T> = {
	value: T;
	/** What the line shows. */
	label: string;
	/** Extra words a search matches, beyond the label. */
	keywords?: string;
	/** Ticked when the list opens. */
	checked?: boolean;
};

export type PickerState = {
	/** Which items are ticked, by their index in the full list. */
	checked: ReadonlySet<number>;
	query: string;
	searching: boolean;
	/** The cursor, as a position in the shown (filtered) list. */
	active: number;
	/**
	 * Showing only ticked items: the ones ticked when the view opened. Unticking
	 * one keeps it in view, so a slip can be undone.
	 */
	onlyTicked: ReadonlySet<number> | undefined;
};

export type PickerEvent =
	| {
			type:
				| "up"
				| "down"
				| "toggle"
				| "toggleShown"
				| "toggleTickedView"
				| "startSearch"
				| "endSearch"
				| "back";
	  }
	| { type: "query"; text: string };

export function initialPicker(items: readonly PickerItem<unknown>[]): PickerState {
	const checked = new Set<number>();
	items.forEach((item, index) => {
		if (item.checked) checked.add(index);
	});
	return { checked, query: "", searching: false, active: 0, onlyTicked: undefined };
}

/** Whether every word of the query appears in the text, ignoring case. */
export function matchesQuery(text: string, query: string): boolean {
	const haystack = text.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

/** The indexes (into the full list) of the items on screen, in order: the view, then the query. */
export function shownItems(
	items: readonly PickerItem<unknown>[],
	state: Pick<PickerState, "query" | "onlyTicked">,
): number[] {
	const out: number[] = [];
	items.forEach((item, index) => {
		if (state.onlyTicked && !state.onlyTicked.has(index)) return;
		if (matchesQuery(`${item.label} ${item.keywords ?? ""}`, state.query)) out.push(index);
	});
	return out;
}

export function pickerReduce(
	state: PickerState,
	event: PickerEvent,
	items: readonly PickerItem<unknown>[],
): PickerState {
	const shown = shownItems(items, state);
	switch (event.type) {
		case "up":
			return { ...state, active: Math.max(0, state.active - 1) };
		case "down":
			return { ...state, active: Math.min(Math.max(0, shown.length - 1), state.active + 1) };
		case "toggle": {
			const index = shown[state.active];
			if (index === undefined) return state;
			const checked = new Set(state.checked);
			if (!checked.delete(index)) checked.add(index);
			return { ...state, checked };
		}
		case "toggleShown": {
			// Tick them all, unless they're all ticked already: then untick them.
			const all = shown.length > 0 && shown.every((i) => state.checked.has(i));
			const checked = new Set(state.checked);
			for (const i of shown) {
				if (all) checked.delete(i);
				else checked.add(i);
			}
			return { ...state, checked };
		}
		case "toggleTickedView":
			// Opening it shows every ticked item, so any filter goes; `/` still searches within it.
			return state.onlyTicked
				? { ...state, onlyTicked: undefined, active: 0 }
				: { ...state, onlyTicked: new Set(state.checked), query: "", active: 0 };
		case "startSearch":
			return { ...state, searching: true, query: "", active: 0 };
		case "query":
			return { ...state, query: event.text, active: 0 };
		case "endSearch":
			return { ...state, searching: false };
		case "back":
			// Out of a search first, then out of the filter and the ticked-only view.
			return state.searching
				? { ...state, searching: false, query: "", active: 0 }
				: { ...state, query: "", onlyTicked: undefined, active: 0 };
	}
}

/** The ticked values, in list order. */
export function pickedValues<T>(items: readonly PickerItem<T>[], state: PickerState): T[] {
	return items.filter((_, i) => state.checked.has(i)).map((item) => item.value);
}

type Config<T> = {
	message: string;
	items: readonly PickerItem<T>[];
	pageSize?: number;
};

const NO_MATCH = -1;

const keyHelp = (keys: [string, string][]) =>
	keys
		.map(([key, action]) => `${styleText("bold", key)} ${styleText("dim", action)}`)
		.join(styleText("dim", " • "));

/** Resolves with the ticked values. Ctrl+C rejects with inquirer's ExitPromptError, as other prompts do. */
export const devicePicker = createPrompt(<T>(config: Config<T>, done: (value: T[]) => void) => {
	const { items, pageSize = 15 } = config;
	const theme = makeTheme({});
	const [status, setStatus] = useState<"idle" | "done">("idle");
	const [state, setState] = useState<PickerState>(() => initialPicker(items));
	const prefix = usePrefix({ status, theme });
	const shown = shownItems(items, state);

	useKeypress((key, rl) => {
		const apply = (event: PickerEvent) => setState(pickerReduce(state, event, items));
		const sequence = (key as { sequence?: string }).sequence;

		if (key.name === "escape") {
			rl.clearLine(0);
			apply({ type: "back" });
		} else if (isUpKey(key)) {
			apply({ type: "up" });
		} else if (isDownKey(key)) {
			apply({ type: "down" });
		} else if (state.searching) {
			if (isEnterKey(key)) apply({ type: "endSearch" });
			else apply({ type: "query", text: rl.line });
		} else {
			// Not searching, so nothing typed is text: keep readline's line empty.
			rl.clearLine(0);
			if (isEnterKey(key)) {
				setStatus("done");
				done(pickedValues(items, state));
			} else if (sequence === "/") {
				apply({ type: "startSearch" });
			} else if (isSpaceKey(key)) {
				apply({ type: "toggle" });
			} else if (key.name === "a") {
				apply({ type: "toggleShown" });
			} else if (key.name === "s") {
				apply({ type: "toggleTickedView" });
			}
		}
	});

	const message = theme.style.message(config.message, status);
	if (status === "done") {
		return `${prefix} ${message} ${theme.style.answer(`${state.checked.size} ticked`)}`;
	}

	const page = usePagination({
		items: shown.length > 0 ? shown : [NO_MATCH],
		active: shown.length > 0 ? state.active : 0,
		pageSize,
		loop: false,
		renderItem: ({ item, isActive }) => {
			if (item === NO_MATCH) {
				return styleText(
					"dim",
					`  ${state.onlyTicked ? "Nothing ticked" : "Nothing matches"}. esc to go back.`,
				);
			}
			const line = `${isActive ? "❯" : " "}${state.checked.has(item) ? styleText("green", "◉") : "◯"} ${items[item]?.label}`;
			return isActive ? theme.style.highlight(line) : line;
		},
	});

	const counts = styleText(
		"dim",
		`${state.checked.size} ticked · ${shown.length} of ${items.length} shown`,
	);
	const view = state.onlyTicked ? styleText("cyan", "showing ticked only") : "";
	const query = state.searching
		? `${styleText("cyan", "/")}${state.query}${styleText("inverse", " ")}`
		: state.query
			? `${styleText("cyan", "filter:")} ${state.query}`
			: "";
	const search = [view, query].filter(Boolean).join(styleText("dim", " · "));
	const help = state.searching
		? keyHelp([
				["type", "filter"],
				["⏎", "keep filter"],
				["esc", "back"],
			])
		: keyHelp([
				["↑↓", "move"],
				["space", "tick"],
				["a", "tick shown"],
				["s", state.onlyTicked ? "show all" : "show ticked"],
				["/", "search"],
				...(state.query || state.onlyTicked ? ([["esc", "back"]] as [string, string][]) : []),
				["⏎", "done"],
			]);

	return [`${prefix} ${message}  ${counts}`, search, page, " ", help].filter(Boolean).join("\n");
});
