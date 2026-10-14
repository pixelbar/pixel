import { describe, expect, it } from "vitest";
import {
	initialPicker,
	matchesQuery,
	type PickerEvent,
	type PickerItem,
	type PickerState,
	pickedValues,
	pickerReduce,
	shownItems,
} from "./device-picker.ts";

const items: PickerItem<string>[] = [
	{ value: "red", label: "light  Traffic Light Red · Hacking Room", keywords: "traffic-light-red" },
	{ value: "green", label: "light  Traffic Light Green · Hacking Room" },
	{ value: "laser", label: "switch Laser cutter · Workshop" },
	{ value: "door", label: "door   Back door", keywords: "back-door" },
];

const run = (...events: PickerEvent[]): PickerState =>
	events.reduce((state, event) => pickerReduce(state, event, items), initialPicker(items));

describe("matching", () => {
	it("needs every word, in any order and case", () => {
		expect(matchesQuery("Traffic Light Red · Hacking Room", "hacking RED")).toBe(true);
		expect(matchesQuery("Traffic Light Red", "red blue")).toBe(false);
		expect(matchesQuery("anything", "  ")).toBe(true);
	});

	it("searches the keywords as well as the label", () => {
		expect(shownItems(items, { query: "back-door", onlyTicked: undefined })).toEqual([3]);
		expect(shownItems(items, { query: "traffic", onlyTicked: undefined })).toEqual([0, 1]);
		expect(shownItems(items, { query: "", onlyTicked: undefined })).toEqual([0, 1, 2, 3]);
	});
});

describe("pickerReduce", () => {
	it("moves within the shown list and stops at the ends", () => {
		expect(run({ type: "up" }).active).toBe(0);
		expect(run({ type: "down" }, { type: "down" }).active).toBe(2);
		expect(run(...Array<PickerEvent>(9).fill({ type: "down" })).active).toBe(3);
	});

	it("ticks and unticks the item under the cursor", () => {
		const ticked = run({ type: "down" }, { type: "toggle" });
		expect(pickedValues(items, ticked)).toEqual(["green"]);
		expect(pickerReduce(ticked, { type: "toggle" }, items).checked.size).toBe(0);
	});

	it("searches with / and filters as you type, from the top", () => {
		const state = run(
			{ type: "down" },
			{ type: "down" },
			{ type: "startSearch" },
			{ type: "query", text: "traffic" },
		);
		expect(state).toMatchObject({ searching: true, query: "traffic", active: 0 });
		expect(shownItems(items, state)).toEqual([0, 1]);
	});

	it("ticks what the cursor is on in the filtered list", () => {
		const state = run(
			{ type: "startSearch" },
			{ type: "query", text: "door" },
			{ type: "endSearch" },
			{ type: "toggle" },
		);
		expect(pickedValues(items, state)).toEqual(["door"]);
	});

	it("keeps the filter on enter, and goes back to the full list on esc", () => {
		const kept = run(
			{ type: "startSearch" },
			{ type: "query", text: "laser" },
			{ type: "endSearch" },
		);
		expect(kept).toMatchObject({ searching: false, query: "laser" });
		expect(pickerReduce(kept, { type: "back" }, items)).toMatchObject({
			searching: false,
			query: "",
			active: 0,
		});
		const searching = run({ type: "startSearch" }, { type: "query", text: "laser" });
		expect(pickerReduce(searching, { type: "back" }, items)).toMatchObject({
			searching: false,
			query: "",
		});
	});

	it("keeps ticks across searches", () => {
		const state = run(
			{ type: "startSearch" },
			{ type: "query", text: "red" },
			{ type: "endSearch" },
			{ type: "toggle" },
			{ type: "back" },
			{ type: "startSearch" },
			{ type: "query", text: "laser" },
			{ type: "endSearch" },
			{ type: "toggle" },
		);
		expect(pickedValues(items, state)).toEqual(["red", "laser"]);
	});

	it("ticks every shown item, or unticks them when they all are", () => {
		const some = run(
			{ type: "startSearch" },
			{ type: "query", text: "traffic" },
			{ type: "endSearch" },
			{ type: "toggleShown" },
		);
		expect(pickedValues(items, some)).toEqual(["red", "green"]);
		expect(pickerReduce(some, { type: "toggleShown" }, items).checked.size).toBe(0);
	});

	it("does nothing when nothing matches", () => {
		const none = run({ type: "startSearch" }, { type: "query", text: "zzz" });
		expect(shownItems(items, none)).toEqual([]);
		expect(pickerReduce(none, { type: "toggle" }, items)).toBe(none);
		expect(pickerReduce(none, { type: "toggleShown" }, items).checked.size).toBe(0);
		expect(pickerReduce(none, { type: "down" }, items).active).toBe(0);
	});

	it("starts with the items marked as ticked", () => {
		const listed = items.map((item, i) => ({ ...item, checked: i === 1 || i === 3 }));
		expect(pickedValues(listed, initialPicker(listed))).toEqual(["green", "door"]);
		expect(initialPicker(items).checked.size).toBe(0);
	});

	it("shows only what's ticked with s, and everything again with s", () => {
		const view = run(
			{ type: "down" },
			{ type: "toggle" },
			{ type: "down" },
			{ type: "down" },
			{ type: "toggle" },
			{ type: "toggleTickedView" },
		);
		expect(view.active).toBe(0);
		expect(shownItems(items, view)).toEqual([1, 3]);
		expect(shownItems(items, pickerReduce(view, { type: "toggleTickedView" }, items))).toEqual([
			0, 1, 2, 3,
		]);
	});

	it("keeps an unticked item in the ticked view until it's left", () => {
		const view = run({ type: "toggle" }, { type: "toggleTickedView" }, { type: "toggle" });
		expect(view.checked.size).toBe(0);
		expect(shownItems(items, view)).toEqual([0]);
		const retick = pickerReduce(view, { type: "toggle" }, items);
		expect(pickedValues(items, retick)).toEqual(["red"]);
	});

	it("searches within the ticked view", () => {
		const view = run(
			{ type: "toggleShown" },
			{ type: "toggleTickedView" },
			{ type: "startSearch" },
			{ type: "query", text: "traffic" },
		);
		expect(shownItems(items, view)).toEqual([0, 1]);
	});

	it("goes back one step at a time with esc", () => {
		const searching = run(
			{ type: "toggle" },
			{ type: "toggleTickedView" },
			{ type: "startSearch" },
			{ type: "query", text: "red" },
		);
		const outOfSearch = pickerReduce(searching, { type: "back" }, items);
		expect(outOfSearch).toMatchObject({ searching: false, query: "" });
		expect(outOfSearch.onlyTicked).toBeDefined();
		const outOfView = pickerReduce(outOfSearch, { type: "back" }, items);
		expect(outOfView.onlyTicked).toBeUndefined();
		expect(shownItems(items, outOfView)).toHaveLength(4);
		expect(pickedValues(items, outOfView)).toEqual(["red"]);
	});

	it("shows every ticked item, whatever the filter was", () => {
		const view = run(
			{ type: "toggleShown" },
			{ type: "startSearch" },
			{ type: "query", text: "laser" },
			{ type: "endSearch" },
			{ type: "toggleTickedView" },
		);
		expect(view.query).toBe("");
		expect(shownItems(items, view)).toEqual([0, 1, 2, 3]);
	});

	it("says nothing is ticked when the ticked view is empty", () => {
		const empty = run({ type: "toggleTickedView" });
		expect(shownItems(items, empty)).toEqual([]);
	});
});
