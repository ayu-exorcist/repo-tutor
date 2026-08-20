<script lang="ts">
	import BranchCard from "$components/branch/BranchCard.svelte";
	import CherryApplyModal from "$components/commit/CherryApplyModal.svelte";
	import CommitContextMenu, {
		type CommitContextData,
	} from "$components/commit/CommitContextMenu.svelte";
	import CommitListItem from "$components/commit/CommitListItem.svelte";
	import ChangedFilesPanel from "$components/files/ChangedFilesPanel.svelte";
	import ReduxResult from "$components/shared/ReduxResult.svelte";
	import { commitCommittedAt } from "$lib/branches/v3";
	import { createCommitSelection } from "$lib/selection/key";
	import { getColorFromPushStatus, pushStatusToIcon } from "$lib/stacks/stack";
	import { STACK_SERVICE } from "$lib/stacks/stackService.svelte";
	import { inject } from "@gitbutler/core/context";
	import type { BranchDetails, Commit, Segment, UpstreamCommit } from "@gitbutler/but-sdk";

	type Props = {
		projectId: string;
		stackId?: string;
		branchName?: string;
		segment?: Segment;
		remote?: string;
		isTopBranch?: boolean;
		isTarget?: boolean;
		inWorkspace?: boolean;
		selectedCommitId?: string;
		selectedCommitIds?: string[];
		onCommitClick: (commitId: string, event: MouseEvent, orderedCommitIds: string[]) => void;
		onFileClick: (index: number) => void;
		onerror?: (error: unknown) => void;
	};

	const {
		projectId,
		stackId,
		branchName,
		segment,
		remote,
		isTopBranch = true,
		inWorkspace: _inWorkspace,
		isTarget: _isTarget,
		selectedCommitId,
		selectedCommitIds = [],
		onCommitClick,
		onFileClick,
		onerror,
	}: Props = $props();

	const stackService = inject(STACK_SERVICE);
	let cherryApplyModal = $state<CherryApplyModal>();
	let cherryPickCommitId = $state<string>();
</script>

{#if segment}
	{@render branchCard(segment, { projectId, stackId })}
{:else if stackId && branchName}
	{@const branchQuery = stackService.branchDetails(projectId, stackId, branchName)}
	<ReduxResult result={branchQuery.result} {projectId} {stackId} {onerror}>
		{#snippet children(branch, env)}
			{@render branchCard(branch, env)}
		{/snippet}
	</ReduxResult>
{:else if branchName}
	{@const branchQuery = stackService.unstackedBranchDetails(projectId, branchName, remote)}
	<ReduxResult result={branchQuery.result} {projectId} {stackId} {onerror}>
		{#snippet children(branch, env)}
			{@render branchCard(branch, env)}
		{/snippet}
	</ReduxResult>
{/if}

{#snippet renderChangedFiles(commitId: string)}
	{@const changesQuery = stackService.commitChanges(projectId, commitId)}

	<ReduxResult {projectId} {stackId} result={changesQuery.result}>
		{#snippet children(changesResult)}
			<ChangedFilesPanel
				title="Changed files"
				{projectId}
				{stackId}
				draggableFiles
				selectionId={createCommitSelection({ commitId, stackId })}
				changes={changesResult.changes.filter(
					(change) => !(change.path in (changesResult.conflictEntries?.entries ?? {})),
				)}
				stats={changesResult.stats ?? undefined}
				conflictEntries={changesResult.conflictEntries}
				autoselect
				allowUnselect={false}
				{onFileClick}
			/>
		{/snippet}
	</ReduxResult>
{/snippet}

{#snippet renderCommitRow(commit: Commit, idx: number, orderedCommitIds: string[])}
	{@const commitType: "LocalOnly" | "LocalAndRemote" | "Integrated" = commit.state.type}
	{@const isDiverged = commit.state.type === "LocalAndRemote" && commit.id !== commit.state.subject}
	{@const isSelected = selectedCommitIds.includes(commit.id)}
	{@const isMultiSelected = isSelected && selectedCommitIds.length > 1}
	{@const contextData = (
		commit.state.type === "Integrated"
			? {
					stackId,
					commitId: commit.id,
					commitMessage: commit.message,
					commitStatus: "Integrated" as const,
					multiSelect: isMultiSelected ? { commitIds: selectedCommitIds } : undefined,
				}
			: {
					stackId,
					commitId: commit.id,
					commitMessage: commit.message,
					commitStatus: commit.state.type,
					hasConflicts: commit.hasConflicts,
					readOnly: true,
					onUncommitClick: () => {},
					onEditMessageClick: () => {},
					multiSelect: isMultiSelected
						? {
								commitIds: selectedCommitIds,
								onSquashSelected: () => {},
								onUncommitSelected: () => {},
							}
						: undefined,
				}
	) satisfies CommitContextData}
	{#snippet menu({ rightClickTrigger }: { rightClickTrigger: HTMLElement })}
		<CommitContextMenu
			showOnHover
			{projectId}
			{rightClickTrigger}
			{contextData}
			onCherryPick={commit.state.type === "Integrated"
				? undefined
				: () => {
						cherryPickCommitId = commit.id;
						cherryApplyModal?.open();
					}}
		/>
	{/snippet}
	<CommitListItem
		disableCommitActions={false}
		{stackId}
		type={commitType}
		diverged={isDiverged}
		commitMessage={commit.message}
		gerritReviewUrl={commit.gerritReviewUrl ?? undefined}
		committedAt={commitCommittedAt(commit)}
		commitId={commit.id}
		{branchName}
		selected={isSelected}
		active={commit.id === selectedCommitId}
		expandChangedFiles={isSelected && selectedCommitIds.length <= 1}
		lastCommit={idx === orderedCommitIds.length - 1}
		onclick={(event) => onCommitClick(commit.id, event, orderedCommitIds)}
		{menu}
	>
		{#snippet changedFiles()}
			{@render renderChangedFiles(commit.id)}
		{/snippet}
	</CommitListItem>
{/snippet}

{#snippet renderUpstreamCommitRow(commit: UpstreamCommit, idx: number, orderedCommitIds: string[])}
	{@const isSelected = selectedCommitIds.includes(commit.id)}
	{@const isMultiSelected = isSelected && selectedCommitIds.length > 1}
	{@const contextData = {
		stackId,
		commitId: commit.id,
		commitMessage: commit.message,
		commitStatus: "Remote" as const,
		multiSelect: isMultiSelected ? { commitIds: selectedCommitIds } : undefined,
	} satisfies CommitContextData}
	{#snippet menu({ rightClickTrigger }: { rightClickTrigger: HTMLElement })}
		<CommitContextMenu showOnHover {projectId} {rightClickTrigger} {contextData} />
	{/snippet}
	<CommitListItem
		disableCommitActions={false}
		{stackId}
		type="Remote"
		commitMessage={commit.message}
		committedAt={commitCommittedAt(commit)}
		commitId={commit.id}
		{branchName}
		selected={isSelected}
		active={commit.id === selectedCommitId}
		expandChangedFiles={isSelected && selectedCommitIds.length <= 1}
		lastCommit={idx === orderedCommitIds.length - 1}
		onclick={(event) => onCommitClick(commit.id, event, orderedCommitIds)}
		{menu}
	>
		{#snippet changedFiles()}
			{@render renderChangedFiles(commit.id)}
		{/snippet}
	</CommitListItem>
{/snippet}

{#snippet branchCard(branch: BranchDetails | Segment, env: { projectId: string; stackId?: string })}
	{@const commitColor = getColorFromPushStatus(branch.pushStatus)}
	{@const localCommits = branch.commits ?? []}
	{@const upstreamCommits =
		"commitsOnRemote" in branch ? branch.commitsOnRemote : (branch.upstreamCommits ?? [])}
	{@const orderedCommitIds = [...upstreamCommits, ...localCommits].map((commit) => commit.id)}
	{@const hasCommits = orderedCommitIds.length > 0}
	{@const trackingBranch =
		"refName" in branch
			? branch.remoteTrackingRefName
				? new TextDecoder().decode(new Uint8Array(branch.remoteTrackingRefName.fullNameBytes))
				: undefined
			: branch.remoteTrackingBranch || undefined}
	{@const displayBranchName =
		branchName ?? ("refName" in branch ? branch.refName?.displayName : branch.name)}

	<BranchCard
		type="normal-branch"
		first={isTopBranch}
		lineColor={commitColor}
		projectId={env.projectId}
		branchName={displayBranchName ?? "Unnamed segment"}
		{isTopBranch}
		isNewBranch={!hasCommits}
		iconName={pushStatusToIcon(branch.pushStatus)}
		{trackingBranch}
		readonly
		roundedBottom={!hasCommits}
		selected={false}
		disableClick
	>
		{#snippet branchContent()}
			{#if hasCommits}
				<div class="branch-commits">
					{#each upstreamCommits as commit, idx}
						{@render renderUpstreamCommitRow(commit, idx, orderedCommitIds)}
					{/each}
					{#each localCommits as commit, idx}
						{@render renderCommitRow(commit, upstreamCommits.length + idx, orderedCommitIds)}
					{/each}
				</div>
			{/if}
		{/snippet}
	</BranchCard>
{/snippet}

<CherryApplyModal bind:this={cherryApplyModal} {projectId} subject={cherryPickCommitId} />

<style lang="postcss">
	.branch-commits {
		overflow: hidden;
		border: 1px solid var(--border-2);
		border-radius: 0 0 var(--radius-ml) var(--radius-ml);
	}
</style>
