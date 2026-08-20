import {
	assembleCommitAuditMaterial,
	type CommitAuditChangesSource,
	type CommitAuditCommitSource,
	type CommitAuditMaterialAdapters,
} from "$lib/ai/commitAuditMaterial";
import type { ChangeDiff } from "$lib/hunks/diffService.svelte";
import type { UnifiedDiff } from "$lib/hunks/diff";
import type { TreeChange } from "@gitbutler/but-sdk";
import { describe, expect, test, vi } from "vitest";

const author = {
	name: "Ada Lovelace",
	email: "ada@example.com",
	gravatarUrl: "",
};

function commit(
	id: string,
	overrides: Partial<CommitAuditCommitSource> = {},
): CommitAuditCommitSource {
	return {
		id,
		message: `message for ${id}`,
		author,
		authoredAt: 10,
		committedAt: 20,
		parentIds: ["parent-1"],
		hasConflicts: false,
		...overrides,
	};
}

function change(path: string): TreeChange {
	return {
		path,
		pathBytes: [],
		status: {
			type: "Addition",
			subject: { state: { id: "blob", kind: "Blob" }, isUntracked: false },
		},
	};
}

function patch(...hunks: string[]): UnifiedDiff {
	return {
		type: "Patch",
		subject: {
			hunks: hunks.map((diff) => ({
				oldStart: 1,
				oldLines: 1,
				newStart: 1,
				newLines: 1,
				diff,
			})),
			isResultOfBinaryToTextConversion: false,
			linesAdded: hunks.length,
			linesRemoved: 0,
		},
	};
}

function details(changes: TreeChange[]): CommitAuditChangesSource {
	return {
		changes,
		stats: { linesAdded: 2, linesRemoved: 1, filesChanged: changes.length },
		conflictEntries: {
			entries: {
				base: { ancestor: true, ours: false, theirs: false },
				ours: { ancestor: false, ours: true, theirs: false },
				theirs: { ancestor: false, ours: false, theirs: true },
			},
		},
	};
}

function adapters(
	overrides: Partial<CommitAuditMaterialAdapters> = {},
): CommitAuditMaterialAdapters {
	return {
		fetchCommitsByIds: vi.fn(),
		fetchCommitChanges: vi.fn(),
		fetchChanges: vi.fn(),
		...overrides,
	};
}

describe("assembleCommitAuditMaterial", () => {
	test("normalizes IDs and keeps commits, files, and hunks in input order despite asynchronous completion", async () => {
		const source = adapters({
			fetchCommitsByIds: async () => [commit("second"), commit("first")],
			fetchCommitChanges: async (_projectId, commitId) => {
				if (commitId === "first") {
					await Promise.resolve();
					return details([change("z.ts"), change("a.ts")]);
				}
				return details([change("a.ts")]);
			},
			fetchChanges: async (_projectId, changes) => {
				if (changes[0]?.path === "z.ts") {
					await Promise.resolve();
					return [
						{
							path: "z.ts",
							diff: patch("@@ -1 +1 @@ z\n+z", "@@ -3 +3 @@ z\n+zz"),
						},
						{ path: "a.ts", diff: patch("@@ -1 +1 @@ a\n+a") },
					];
				}
				return [{ path: "a.ts", diff: patch("@@ -1 +1 @@ prior\n+prior") }];
			},
		});

		const material = await assembleCommitAuditMaterial(
			{ projectId: "project", commitIds: [" first ", "second", "first", ""] },
			source,
		);

		expect(material.missingMaterials).toEqual([]);
		expect(material.commits.map((item) => item.id)).toEqual(["first", "second"]);
		expect(material.commits[0]).toMatchObject({
			message: "message for first",
			metadata: {
				author,
				authoredAt: 10,
				committedAt: 20,
				parentIds: ["parent-1"],
				firstParentId: "parent-1",
				lineStats: { linesAdded: 2, linesRemoved: 1, filesChanged: 2 },
				conflictEntries: {
					entries: {
						base: { ancestor: true, ours: false, theirs: false },
						ours: { ancestor: false, ours: true, theirs: false },
						theirs: { ancestor: false, ours: false, theirs: true },
					},
				},
			},
		});
		expect(material.commits[0]?.files.map((file) => file.path)).toEqual(["z.ts", "a.ts"]);
		expect(material.commits[0]?.files[0]?.hunks?.map((hunk) => hunk.id)).toEqual([
			"first:z.ts:0",
			"first:z.ts:1",
		]);
	});

	test("keeps same-path files separate across commits with commit-scoped hunk IDs", async () => {
		const source = adapters({
			fetchCommitsByIds: async () => [commit("one"), commit("two")],
			fetchCommitChanges: async () => details([change("shared.ts")]),
			fetchChanges: async (_projectId, changes) => [
				{ path: changes[0]!.path, diff: patch("@@ -1 +1 @@ shared\n+change") },
			],
		});

		const material = await assembleCommitAuditMaterial(
			{ projectId: "project", commitIds: ["one", "two"] },
			source,
		);

		expect(material.commits).toHaveLength(2);
		expect(material.commits.map((item) => item.files)).toEqual([
			[
				{
					path: "shared.ts",
					patch: "@@ -1 +1 @@ shared\n+change",
					hunks: [
						{
							id: "one:shared.ts:0",
							header: "@@ -1 +1 @@ shared",
							patch: "@@ -1 +1 @@ shared\n+change",
						},
					],
				},
			],
			[
				{
					path: "shared.ts",
					patch: "@@ -1 +1 @@ shared\n+change",
					hunks: [
						{
							id: "two:shared.ts:0",
							header: "@@ -1 +1 @@ shared",
							patch: "@@ -1 +1 @@ shared\n+change",
						},
					],
				},
			],
		]);
	});

	test("keeps every changed file and describes Binary, TooLarge, and empty patches as missing", async () => {
		const source = adapters({
			fetchCommitsByIds: async () => [commit("abc")],
			fetchCommitChanges: async () =>
				details([change("binary.png"), change("large.log"), change("empty.ts")]),
			fetchChanges: async (): Promise<ChangeDiff[]> => [
				{ path: "binary.png", diff: { type: "Binary" } },
				{
					path: "large.log",
					diff: { type: "TooLarge", subject: { sizeInBytes: 4096 } },
				},
				{ path: "empty.ts", diff: null },
			],
		});

		const material = await assembleCommitAuditMaterial(
			{ projectId: "project", commitIds: ["abc"] },
			source,
		);

		expect(material.commits[0]?.files).toEqual([
			{ path: "binary.png", patch: "" },
			{ path: "large.log", patch: "" },
			{ path: "empty.ts", patch: "" },
		]);
		expect(material.missingMaterials).toEqual([
			"Patch is unavailable for abc:binary.png: binary file.",
			"Patch is unavailable for abc:large.log: file is too large (4096 bytes).",
			"Patch is unavailable for abc:empty.ts: empty response.",
		]);
	});

	test("records retrieval failures without discarding available commit metadata or files", async () => {
		const source = adapters({
			fetchCommitsByIds: async () => [commit("available")],
			fetchCommitChanges: async () => details([change("unavailable.patch")]),
			fetchChanges: async () => {
				throw new Error("diff failed");
			},
		});

		const material = await assembleCommitAuditMaterial(
			{
				projectId: "project",
				commitIds: ["missing", "available", "broken-changes"],
			},
			source,
		);

		expect(material.commits.map((item) => item.id)).toEqual(["available"]);
		expect(material.commits[0]?.files).toEqual([{ path: "unavailable.patch", patch: "" }]);
		expect(material.missingMaterials).toEqual([
			"Commit metadata is unavailable for missing: commit was not returned.",
			"Commit metadata is unavailable for broken-changes: commit was not returned.",
			"Patches are unavailable for available: request failed.",
			"Patch is unavailable for available:unavailable.patch: no response.",
		]);
	});

	test("retains commit metadata when fetching a commit's changes fails", async () => {
		const source = adapters({
			fetchCommitsByIds: async () => [commit("broken")],
			fetchCommitChanges: async () => {
				throw new Error("backend failed");
			},
		});

		const material = await assembleCommitAuditMaterial(
			{ projectId: "project", commitIds: ["broken"] },
			source,
		);

		expect(material.commits).toMatchObject([
			{ id: "broken", message: "message for broken", files: [] },
		]);
		expect(material.missingMaterials).toEqual([
			"Commit changes are unavailable for broken: request failed.",
		]);
	});

	test("uses direct commit sources in normalized request order without fetching metadata", async () => {
		const fetchCommitsByIds = vi.fn();
		const source = adapters({
			fetchCommitsByIds,
			fetchCommitChanges: async (_projectId, commitId) => details([change(`${commitId}.ts`)]),
			fetchChanges: async (_projectId, changes) => [
				{ path: changes[0]!.path, diff: patch(`@@ -1 +1 @@ ${changes[0]!.path}\n+change`) },
			],
		});

		const material = await assembleCommitAuditMaterial(
			{
				projectId: "project",
				commitIds: [" first ", "second", "first"],
				commitSources: [commit("second"), commit("first")],
			},
			source,
		);

		expect(fetchCommitsByIds).not.toHaveBeenCalled();
		expect(material.commits.map((item) => item.id)).toEqual(["first", "second"]);
		expect(material.commits.map((item) => item.files[0]?.path)).toEqual(["first.ts", "second.ts"]);
	});

	test("reports missing direct sources while retaining direct same-path patches", async () => {
		const fetchCommitsByIds = vi.fn();
		const source = adapters({
			fetchCommitsByIds,
			fetchCommitChanges: async () => details([change("shared.ts")]),
			fetchChanges: async () => [{ path: "shared.ts", diff: patch("@@ -1 +1 @@ shared\n+change") }],
		});

		const material = await assembleCommitAuditMaterial(
			{
				projectId: "project",
				commitIds: ["one", "missing", "two"],
				commitSources: [commit("two"), commit("one")],
			},
			source,
		);

		expect(fetchCommitsByIds).not.toHaveBeenCalled();
		expect(material.commits.map((item) => item.id)).toEqual(["one", "two"]);
		expect(material.commits.map((item) => item.files[0]?.hunks?.[0]?.id)).toEqual([
			"one:shared.ts:0",
			"two:shared.ts:0",
		]);
		expect(material.missingMaterials).toEqual([
			"Commit metadata is unavailable for missing: commit was not returned.",
		]);
	});
});
