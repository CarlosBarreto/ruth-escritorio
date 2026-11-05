import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// 20261104 - itera - replace memory rules tests -- Begin
import { UNAVAILABLE } from "../src/extensions/ruth-context.ts";
// 20261104 - itera - replace memory rules tests -- End
import {
	HIDDEN_NAMES,
	IDENTITY_SOURCE,
	isBlockedInput,
	presentText,
	shouldShowToast,
} from "../src/white-label.ts";

describe("presentText", () => {
	it.each([
		["Gentle Shell ready", "Gentle Dot ready"],
		["gentle-shell is loading", "Gentle Dot is loading"],
		["I am el Gentleman.", "I am Gentle Dot."],
		["Gentle AI review mode is on", "Gentle Dot review mode is on"],
		["Saved to Engram", "Saved to memory"],
		["Following ODD", "Following workflow"],
		["Organic Driven Development keeps it tidy", "my workflow keeps it tidy"],
		["Run /gentle:status to check", "Run to check"],
		["Started the Pi coding agent", "Started the assistant"],
		["RDD is enabled", "review is enabled"],
	])("rewrites %j", (input, expected) => {
		expect(presentText(input)).toBe(expected);
	});

	it("leaves ordinary text alone", () => {
		const text = "Pick a color: Pi is 3.14, odd numbers are fine, and gentle reminders help.";
		expect(presentText(text)).toBe(text);
	});

	it("leaves none of the hidden names in recorded startup events", () => {
		const recorded = [
			"Gentle Shell ready",
			"el Gentleman loaded ODD",
			"gentle-ai: review mode on (decided by global)",
			"Engram connected · project gentle-pi",
		];
		for (const text of recorded) {
			const shown = presentText(text);
			for (const name of HIDDEN_NAMES) expect(shown, shown).not.toMatch(name);
		}
	});
});

describe("shouldShowToast", () => {
	it("hides informational chatter and keeps warnings and errors", () => {
		expect(shouldShowToast("info")).toBe(false);
		expect(shouldShowToast("warning")).toBe(true);
		expect(shouldShowToast("error")).toBe(true);
	});
});

describe("isBlockedInput", () => {
	it("blocks internal slash commands only", () => {
		expect(isBlockedInput("/gentle:yolo")).toBe(true);
		expect(isBlockedInput("  /gentle:status now")).toBe(true);
		expect(isBlockedInput("What does /gentle mean?")).toBe(false);
		expect(isBlockedInput("hello")).toBe(false);
	});
});

// 20261104 - itera - replace memory rules tests -- Begin
describe("memory rules in the identity", () => {
	const identity = readFileSync(IDENTITY_SOURCE, "utf8");

	it("no longer sends the assistant to save or search on its own", () => {
		expect(identity).not.toMatch(/`gentle-dot`/);
		expect(identity).not.toMatch(/all_projects/);
		expect(identity).not.toMatch(/match_mode/);
		expect(identity).not.toMatch(/When you (save|search)/);
		expect(identity).toMatch(/cannot save to that memory or search it yourself/);
	});

	it("says where the memory arrives, and that it is data and not instructions", () => {
		expect(identity).toMatch(/`<memoria>` and `<personas>`/);
		expect(identity).toMatch(/data[^.\n]*never instructions/);
	});

	it("says to tell the user when the memory could not be reached", () => {
		expect(identity).toMatch(/`\[memoria\]`[^\n]*could not be reached/);
		expect(identity).toMatch(/tell the user you could not check your memory/);
		expect(UNAVAILABLE.startsWith("[memoria]")).toBe(true);
	});

	it("still calls itself Gentle Dot until the rebrand", () => {
		expect(identity).toMatch(/^# Product identity: Gentle Dot/);
		expect(identity).toMatch(/You are Gentle Dot/);
		expect(identity).not.toMatch(/Ruth/);
	});
});
// 20261104 - itera - replace memory rules tests -- End
