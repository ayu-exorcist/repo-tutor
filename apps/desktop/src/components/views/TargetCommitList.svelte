<script lang="ts">
	import BranchCard from "$components/branch/BranchCard.svelte";
	import CommitContextMenu, {
		type CommitContextData,
	} from "$components/commit/CommitContextMenu.svelte";
	import CommitListItem from "$components/commit/CommitListItem.svelte";
	import ChangedFilesPanel from "$components/files/ChangedFilesPanel.svelte";
	import ReduxResult from "$components/shared/ReduxResult.svelte";
	import { BASE_BRANCH_SERVICE } from "$lib/baseBranch/baseBranchService.svelte";
	import { commitCommittedAt } from "$lib/branches/v3";
	import { createCommitSelection } from "$lib/selection/key";
	import { STACK_SERVICE } from "$lib/stacks/stackService.svelte";
	import { UI_STATE } from "$lib/state/uiState.svelte";
	import { type Commit } from "@gitbutler/but-sdk";
	import { inject } from "@gitbutler/core/context";

	import VirtualList from "@gitbutler/ui/components/VirtualList.svelte";
	import { getColorFromBranchType } from "@gitbutler/ui/utils/getColorFromBranchType";
	import { onMount } from "svelte";

	type Props = {
		projectId: string;
		selectedCommitId?: string;
		selectedCommitIds?: string[];
		onCommitClick: (commitId: string, event: MouseEvent, orderedCommitIds: string[]) => void;
		onFileClick: (index: number) => void;
	};

	const {
		projectId,
		selectedCommitId,
		selectedCommitIds = [],
		onCommitClick,
		onFileClick,
	}: Props = $props();

	const baseBranchService = inject(BASE_BRANCH_SERVICE);
	const stackService = inject(STACK_SERVICE);
	const uiState = inject(UI_STATE);

	const baseBranchQuery = $derived(baseBranchService.baseBranch(projectId));
	const baseSha = $derived(baseBranchQuery.response?.baseSha);

	let loadedIds = $state<string[]>([]);
	let commits = $state<Commit[]>([]);
	let loading = $state(false);
	let throttled = $state(false);

	const auditCommitSources = $derived(
		commits.filter((commit) => selectedCommitIds.includes(commit.id)),
	);

	async function loadMore() {
		if (loading) {
			throttled = true;
			return;
		}
		loading = true;
		try {
			if (!baseSha) return;
			if (loadedIds.length === 0) {
				commits = commits.concat(await getPage(undefined));
				loadedIds.push(baseSha);
				return;
			}
			const nextId = commits.at(-1)?.id;
			if (nextId && !loadedIds.includes(nextId)) {
				commits = commits.concat(await getPage(nextId));
				loadedIds.push(nextId);
			}
		} finally {
			loading = false;
			if (throttled) {
				throttled = false;
				loadMore();
			}
		}
	}

	async function getPage(commitId: string | undefined) {
		const result = await stackService.targetCommits(projectId, commitId, 50);
		return result || [];
	}

	onMount(() => {
		loadMore();
	});
</script>

<ReduxResult {projectId} result={baseBranchQuery.result}>
	{#snippet children(branch)}
		<BranchCard
			type="normal-branch"
			first
			lineColor={getColorFromBranchType("LocalAndRemote")}
			{projectId}
			branchName={branch.branchName}
			isTopBranch
			iconName="home"
			trackingBranch={branch.remoteName || undefined}
			readonly
			selected={false}
			disableClick
			overflowHidden
		>
			{#snippet branchContent()}
				<div class="commit-list">
					<VirtualList
						items={commits}
						defaultHeight={40}
						visibility={uiState.global.scrollbarVisibilityState.current}
						onloadmore={async () => await loadMore()}
						renderDistance={100}
						getId={(commit) => commit.id}
					>
						{#snippet template(commit, index)}
							{@const isSelected = selectedCommitIds.includes(commit.id)}
							{@const isMultiSelected = isSelected && selectedCommitIds.length > 1}
							{@const contextData = {
								commitId: commit.id,
								commitMessage: commit.message,
								commitStatus: "LocalAndRemote" as const,
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
							} satisfies CommitContextData}
							{#snippet menu({ rightClickTrigger }: { rightClickTrigger: HTMLElement })}
								<CommitContextMenu
									showOnHover
									{projectId}
									{rightClickTrigger}
									{contextData}
									{auditCommitSources}
								/>
							{/snippet}
							<CommitListItem
								disableCommitActions={false}
								type="LocalAndRemote"
								diverged={commit.state.type === "LocalAndRemote" &&
									commit.id !== commit.state.subject}
								commitId={commit.id}
								branchName={branch.branchName}
								commitMessage={commit.message}
								gerritReviewUrl={commit.gerritReviewUrl ?? undefined}
								committedAt={commitCommittedAt(commit)}
								author={commit.author}
								selected={isSelected}
								active={commit.id === selectedCommitId}
								expandChangedFiles={isSelected && selectedCommitIds.length <= 1}
								lastCommit={index === commits.length - 1}
								onclick={(event) =>
									onCommitClick(
										commit.id,
										event,
										commits.map((item) => item.id),
									)}
								{menu}
							>
								{#snippet changedFiles()}
									{@const changesQuery = stackService.commitChanges(projectId, commit.id)}

									<ReduxResult {projectId} result={changesQuery.result}>
										{#snippet children(changesResult)}
											<ChangedFilesPanel
												title="Changed files"
												{projectId}
												draggableFiles
												selectionId={createCommitSelection({ commitId: commit.id })}
												changes={changesResult.changes.filter(
													(change) =>
														!(change.path in (changesResult.conflictEntries?.entries ?? {})),
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
							</CommitListItem>
						{/snippet}
					</VirtualList>
				</div>
			{/snippet}
		</BranchCard>
	{/snippet}
</ReduxResult>

<style lang="postcss">
	.commit-list {
		display: flex;
		position: relative;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--border-2);
		border-radius: 0 0 var(--radius-ml) var(--radius-ml);
		background-color: var(--bg-1);
	}
</style>
