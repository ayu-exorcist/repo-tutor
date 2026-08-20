import { selectCommit } from "$components/views/commitSelection";
import { describe, expect, test } from "vitest";

const click = (modifiers: Partial<Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">> = {}) =>
	({ ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers }) as Pick<
		MouseEvent,
		"ctrlKey" | "metaKey" | "shiftKey"
	>;

const orderedCommitIds = ["one", "two", "three", "four"];

describe("selectCommit", () => {
	test("selects one commit and makes it the primary diff", () => {
		expect(selectCommit({}, "two", click(), orderedCommitIds)).toEqual({
			commitId: "two",
			commitIds: ["two"],
		});
	});

	test("adds and removes commits with Ctrl or Meta while retaining the latest selected primary", () => {
		const selection = { commitId: "two", commitIds: ["two"] };
		expect(selectCommit(selection, "four", click({ ctrlKey: true }), orderedCommitIds)).toEqual({
			commitId: "four",
			commitIds: ["two", "four"],
		});
		expect(
			selectCommit(
				{ commitId: "four", commitIds: ["two", "four"] },
				"four",
				click({ metaKey: true }),
				orderedCommitIds,
			),
		).toEqual({ commitId: "two", commitIds: ["two"] });
	});

	test("range-selects every ordered commit between the primary and the clicked commit", () => {
		expect(
			selectCommit(
				{ commitId: "four", commitIds: ["four"] },
				"two",
				click({ shiftKey: true }),
				orderedCommitIds,
			),
		).toEqual({ commitId: "two", commitIds: ["two", "three", "four"] });
	});
});
