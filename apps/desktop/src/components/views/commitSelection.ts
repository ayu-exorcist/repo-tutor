export type CommitSelection = {
	commitId?: string;
	commitIds?: string[];
};

/** Updates a commit selection while preserving a primary commit for the diff view. */
export function selectCommit(
	selection: CommitSelection,
	commitId: string,
	event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
	orderedCommitIds: readonly string[],
): CommitSelection {
	const currentIds = selection.commitIds ?? (selection.commitId ? [selection.commitId] : []);
	if (event.metaKey || event.ctrlKey) {
		const commitIds = currentIds.includes(commitId)
			? currentIds.filter((id) => id !== commitId)
			: [...currentIds, commitId];
		return {
			commitId: commitIds.at(-1),
			commitIds: commitIds.length > 0 ? commitIds : undefined,
		};
	}

	if (event.shiftKey && selection.commitId) {
		const anchorIndex = orderedCommitIds.indexOf(selection.commitId);
		const targetIndex = orderedCommitIds.indexOf(commitId);
		if (anchorIndex !== -1 && targetIndex !== -1) {
			const start = Math.min(anchorIndex, targetIndex);
			const end = Math.max(anchorIndex, targetIndex);
			return { commitId, commitIds: [...orderedCommitIds.slice(start, end + 1)] };
		}
	}

	return { commitId, commitIds: [commitId] };
}
