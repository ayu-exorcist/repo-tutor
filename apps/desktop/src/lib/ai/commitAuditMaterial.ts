import { normalizeCommitIds, type CommitAuditMaterial } from "$lib/ai/commitAudit";
import type { ConflictEntriesObj } from "$lib/files/conflicts";
import type { ChangeDiff } from "$lib/hunks/diffService.svelte";
import type { Author, TreeChange, TreeStats } from "@gitbutler/but-sdk";

/** The commit fields needed to assemble audit material. */
export interface CommitAuditCommitSource {
	id: string;
	message: string;
	author: Author;
	authoredAt: number;
	committedAt: number;
	parentIds?: readonly string[];
	hasConflicts?: boolean;
}

/** The commit-detail fields needed to assemble audit material. */
export interface CommitAuditChangesSource {
	changes: TreeChange[];
	stats: TreeStats | null;
	conflictEntries?: ConflictEntriesObj;
}

/** A diff result matching the data returned by DiffService.fetchChanges. */
export type CommitAuditChangeDiff = ChangeDiff;

/**
 * Small dependency boundary for material collection. Callers can adapt StackService
 * and DiffService without coupling this module to Svelte services.
 */
export interface CommitAuditMaterialAdapters {
	fetchCommitsByIds(projectId: string, commitIds: string[]): Promise<CommitAuditCommitSource[]>;
	fetchCommitChanges(projectId: string, commitId: string): Promise<CommitAuditChangesSource>;
	fetchChanges(projectId: string, changes: TreeChange[]): Promise<CommitAuditChangeDiff[]>;
}

/** Input for assembling the model-facing material for one or more commits. */
export interface CommitAuditMaterialRequest {
	projectId: string;
	commitIds: readonly string[];
}

/**
 * Collects commit metadata and patches while preserving normalized input order.
 * Requests for independent commits run concurrently; their completion order never
 * affects the returned material.
 */
export async function assembleCommitAuditMaterial(
	request: CommitAuditMaterialRequest,
	adapters: CommitAuditMaterialAdapters,
): Promise<CommitAuditMaterial> {
	const commitIds = normalizeCommitIds(request.commitIds);
	const missingMaterials: string[] = [];

	let sources: readonly CommitAuditCommitSource[];
	try {
		sources = await adapters.fetchCommitsByIds(request.projectId, commitIds);
	} catch {
		for (const commitId of commitIds) {
			missingMaterials.push(`Commit metadata is unavailable for ${commitId}: request failed.`);
		}
		return { commits: [], missingMaterials };
	}

	const sourcesById = new Map(sources.map((source) => [source.id, source]));
	const orderedSources: CommitAuditCommitSource[] = [];
	for (const commitId of commitIds) {
		const source = sourcesById.get(commitId);
		if (source) {
			orderedSources.push(source);
		} else {
			missingMaterials.push(
				`Commit metadata is unavailable for ${commitId}: commit was not returned.`,
			);
		}
	}

	const collected = await Promise.all(
		orderedSources.map((source) => collectCommitMaterial(request.projectId, source, adapters)),
	);
	for (const result of collected) missingMaterials.push(...result.missingMaterials);

	return {
		commits: collected.map((result) => result.commit),
		missingMaterials,
	};
}

async function collectCommitMaterial(
	projectId: string,
	source: CommitAuditCommitSource,
	adapters: CommitAuditMaterialAdapters,
): Promise<{
	commit: CommitAuditMaterial["commits"][number];
	missingMaterials: string[];
}> {
	const missingMaterials: string[] = [];
	let details: CommitAuditChangesSource;
	try {
		details = await adapters.fetchCommitChanges(projectId, source.id);
	} catch {
		return {
			commit: {
				id: source.id,
				message: source.message,
				metadata: commitMetadata(source, null),
				files: [],
			},
			missingMaterials: [`Commit changes are unavailable for ${source.id}: request failed.`],
		};
	}

	let diffs: readonly CommitAuditChangeDiff[];
	try {
		diffs = await adapters.fetchChanges(projectId, details.changes);
	} catch {
		diffs = [];
		missingMaterials.push(`Patches are unavailable for ${source.id}: request failed.`);
	}

	const diffsByPath = groupDiffsByPath(diffs);
	const files = details.changes.map((change) => {
		const diff = diffsByPath.get(change.path)?.shift();
		return fileMaterial(source.id, change, diff, missingMaterials);
	});

	for (const [path, remaining] of diffsByPath) {
		if (remaining.length > 0) {
			missingMaterials.push(
				`Patch response for ${source.id}:${path} has no matching commit change.`,
			);
		}
	}

	return {
		commit: {
			id: source.id,
			message: source.message,
			metadata: commitMetadata(source, details),
			files,
		},
		missingMaterials,
	};
}

function commitMetadata(source: CommitAuditCommitSource, details: CommitAuditChangesSource | null) {
	const parentIds = source.parentIds ? [...source.parentIds] : [];
	return {
		author: source.author,
		authoredAt: source.authoredAt,
		committedAt: source.committedAt,
		parentIds,
		firstParentId: parentIds[0] ?? null,
		firstParentExplanation:
			parentIds.length > 0
				? "firstParentId is the first entry in parentIds."
				: "No parent IDs were available for this commit.",
		hasConflicts: source.hasConflicts ?? null,
		lineStats: details?.stats ?? null,
		conflictEntries: details?.conflictEntries ?? null,
	};
}

function groupDiffsByPath(diffs: readonly CommitAuditChangeDiff[]) {
	const grouped = new Map<string, CommitAuditChangeDiff[]>();
	for (const diff of diffs) {
		const matches = grouped.get(diff.path);
		if (matches) matches.push(diff);
		else grouped.set(diff.path, [diff]);
	}
	return grouped;
}

function fileMaterial(
	commitId: string,
	change: TreeChange,
	response: CommitAuditChangeDiff | undefined,
	missingMaterials: string[],
): CommitAuditMaterial["commits"][number]["files"][number] {
	const patch = response?.diff;
	if (!response) {
		missingMaterials.push(`Patch is unavailable for ${commitId}:${change.path}: no response.`);
		return { path: change.path, patch: "" };
	}
	if (!patch) {
		missingMaterials.push(`Patch is unavailable for ${commitId}:${change.path}: empty response.`);
		return { path: change.path, patch: "" };
	}
	if (patch.type === "Binary") {
		missingMaterials.push(`Patch is unavailable for ${commitId}:${change.path}: binary file.`);
		return { path: change.path, patch: "" };
	}
	if (patch.type === "TooLarge") {
		missingMaterials.push(
			`Patch is unavailable for ${commitId}:${change.path}: file is too large (${patch.subject.sizeInBytes} bytes).`,
		);
		return { path: change.path, patch: "" };
	}

	const hunks = patch.subject.hunks.map((hunk, index) => ({
		id: `${commitId}:${change.path}:${index}`,
		header: hunk.diff.split(/\r?\n/, 1)[0] ?? "",
		patch: hunk.diff,
	}));
	return {
		path: change.path,
		patch: hunks.map((hunk) => hunk.patch).join("\n"),
		hunks,
	};
}
