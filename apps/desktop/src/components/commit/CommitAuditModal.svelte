<script lang="ts">
	import {
		normalizeCommitIds,
		type CommitAuditMaterial,
		type CommitAuditReport,
		type CommitAuditStatement,
	} from "$lib/ai/commitAudit";
	import {
		assembleCommitAuditMaterial,
		type CommitAuditCommitSource,
	} from "$lib/ai/commitAuditMaterial";
	import { AI_SERVICE } from "$lib/ai/service";
	import { DIFF_SERVICE } from "$lib/hunks/diffService.svelte";
	import { STACK_SERVICE } from "$lib/stacks/stackService.svelte";
	import { inject } from "@gitbutler/core/context";
	import { Button, InfoMessage, Modal } from "@gitbutler/ui";

	type AuditState = "idle" | "loading" | "ready" | "error";

	export type CommitAuditScope = {
		commitIds: readonly string[];
		stackId?: string;
		commitSources?: readonly CommitAuditCommitSource[];
	};

	type Props = {
		projectId: string;
	};

	const { projectId }: Props = $props();
	const stackService = inject(STACK_SERVICE);
	const diffService = inject(DIFF_SERVICE);
	const aiService = inject(AI_SERVICE);

	let modal: Modal | undefined = $state();
	let auditState = $state<AuditState>("idle");
	let scope: CommitAuditScope | undefined = $state();
	let material: CommitAuditMaterial | undefined = $state();
	let report: CommitAuditReport | undefined = $state();
	let errorMessage: string | undefined = $state();
	let runId = 0;

	const isLoading = $derived(auditState === "loading");

	export function show(nextScope: CommitAuditScope) {
		reset();
		scope = {
			...nextScope,
			commitIds: normalizeCommitIds(nextScope.commitIds),
		};
		modal?.show();
		void runAudit();
	}

	function reset() {
		runId += 1;
		auditState = "idle";
		scope = undefined;
		material = undefined;
		report = undefined;
		errorMessage = undefined;
	}

	async function runAudit() {
		const currentRunId = ++runId;
		const selectedScope = scope;
		auditState = "loading";
		errorMessage = undefined;
		report = undefined;
		material = undefined;

		if (!selectedScope) {
			setError(currentRunId, "未选择可审计的提交。");
			return;
		}
		const selectedCommitIds = [...selectedScope.commitIds];
		if (selectedCommitIds.length === 0) {
			setError(currentRunId, "未选择可审计的提交。");
			return;
		}
		if (!selectedScope.stackId && !selectedScope.commitSources) {
			setError(
				currentRunId,
				"该提交既不属于可用的 Stack，也没有可用的提交材料，无法执行 AI 审计。",
			);
			return;
		}

		try {
			if (!(await aiService.validateConfiguration())) {
				setError(currentRunId, "AI 配置不可用，请先在项目设置中完成配置。");
				return;
			}

			const nextMaterial = await assembleCommitAuditMaterial(
				{
					projectId,
					commitIds: selectedCommitIds,
					commitSources: selectedScope.commitSources,
				},
				{
					fetchCommitsByIds: (id, ids) => {
						if (!selectedScope.stackId) {
							throw new Error("No Stack is available for commit metadata.");
						}
						return stackService.fetchCommitsByIds(id, selectedScope.stackId, ids);
					},
					fetchCommitChanges: (id, commitId) => stackService.fetchCommitChanges(id, commitId),
					fetchChanges: (id, changes) => diffService.fetchChanges(id, changes),
				},
			);
			if (currentRunId !== runId) return;
			material = nextMaterial;
			if (nextMaterial.commits.length === 0) {
				setError(
					currentRunId,
					"审计材料不可用，无法生成报告。请重试或检查提交是否仍在当前 Stack 中。",
				);
				return;
			}

			const nextReport = await aiService.analyzeCommitAudit({ material: nextMaterial });
			if (currentRunId !== runId) return;
			if (!nextReport) {
				setError(currentRunId, "AI 未返回审计报告，请检查配置后重试。");
				return;
			}
			report = nextReport;
			auditState = "ready";
		} catch (error: unknown) {
			setError(
				currentRunId,
				error instanceof Error ? error.message : "生成审计报告时发生未知错误。",
			);
		}
	}

	function setError(currentRunId: number, message: string) {
		if (currentRunId !== runId) return;
		auditState = "error";
		errorMessage = message;
	}

	function auditStatementText(auditStatement: CommitAuditStatement | string): string {
		return typeof auditStatement === "string" ? auditStatement : auditStatement.text;
	}

	function formatMetadata(value: unknown): string {
		if (value === undefined || value === null) return "未提供";
		if (typeof value === "string") return value;
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}
</script>

<Modal
	bind:this={modal}
	title="AI 提交审计"
	width="large"
	onClose={reset}
	preventCloseOnClickOutside={isLoading}
>
	<div class="commit-audit-modal">
		{#if auditState === "loading"}
			<InfoMessage style="info" filled outlined={false} icon="ai">
				{#snippet title()}正在生成提交审计{/snippet}
				{#snippet content()}正在收集提交材料并请求 AI 分析，请稍候。{/snippet}
			</InfoMessage>
		{:else if auditState === "error"}
			<InfoMessage style="danger" filled outlined={false} icon="danger">
				{#snippet title()}无法生成提交审计{/snippet}
				{#snippet content()}{errorMessage}{/snippet}
			</InfoMessage>
		{:else if auditState === "ready" && report}
			{@const missingMaterials = material?.missingMaterials ?? []}
			{#if missingMaterials.length > 0}
				<InfoMessage style="warning" filled outlined={false} icon="warning">
					{#snippet title()}审计材料不完整{/snippet}
					{#snippet content()}
						<p>以下材料无法提供给 AI；报告不会把它们当作证据。</p>
						<ul>
							{#each missingMaterials as missingMaterial}
								<li>{missingMaterial}</li>
							{/each}
						</ul>
					{/snippet}
				</InfoMessage>
			{/if}

			<div class="audit-report">
				{#each report.commits as commit}
					<section class="audit-section">
						<h2>{commit.commitHash}</h2>
						<dl class="metadata">
							<div>
								<dt>作者</dt>
								<dd>{formatMetadata(commit.metadata.author)}</dd>
							</div>
							<div>
								<dt>提交时间</dt>
								<dd>{formatMetadata(commit.metadata.committedAt)}</dd>
							</div>
							<div>
								<dt>提交信息</dt>
								<dd>{commit.metadata.message}</dd>
							</div>
						</dl>

						<h3>变更分类</h3>
						<ul>
							{#each commit.changeCategories as category}<li>{category}</li>{/each}
						</ul>

						<h3>客观变更</h3>
						<ul>
							{#each commit.objectiveChanges as change}<li>{auditStatementText(change)}</li>{/each}
						</ul>
						<h3>动机</h3>
						<p>{auditStatementText(commit.motivation)}</p>
						<h3>取舍</h3>
						<p>{auditStatementText(commit.tradeoffs)}</p>
						<h3>风险</h3>
						{#if commit.risks.length > 0}<ul>
								{#each commit.risks as risk}<li>{auditStatementText(risk)}</li>{/each}
							</ul>{:else}<p>未发现明确风险。</p>{/if}
						<h3>关联线索</h3>
						{#if commit.relatedClues.length > 0}<ul>
								{#each commit.relatedClues as clue}<li>{auditStatementText(clue)}</li>{/each}
							</ul>{:else}<p>未发现关联线索。</p>{/if}
						<h3>对抗性审阅：隐性前提</h3>
						<p>{auditStatementText(commit.adversarialReview.hiddenAssumptions)}</p>
						<h3>对抗性审阅：临时方案</h3>
						<p>{auditStatementText(commit.adversarialReview.temporarySolution)}</p>
						<h3>Squash 警告</h3>
						<p>{auditStatementText(commit.squashWarning)}</p>
					</section>
				{/each}

				{#if report.evolutionSummary}
					<section class="audit-section">
						<h2>提交演进摘要</h2>
						<dl class="summary">
							<div>
								<dt>业务与设计目标</dt>
								<dd>{auditStatementText(report.evolutionSummary.businessAndDesignGoals)}</dd>
							</div>
							<div>
								<dt>迭代路径</dt>
								<dd>{auditStatementText(report.evolutionSummary.iterationPath)}</dd>
							</div>
							<div>
								<dt>取舍与技术债</dt>
								<dd>{auditStatementText(report.evolutionSummary.tradeoffsAndDebt)}</dd>
							</div>
							<div>
								<dt>未解释的决策</dt>
								<dd>{auditStatementText(report.evolutionSummary.unexplainedDecisions)}</dd>
							</div>
							<div>
								<dt>临时方案</dt>
								<dd>{auditStatementText(report.evolutionSummary.temporaryApproaches)}</dd>
							</div>
						</dl>
					</section>
				{/if}
			</div>
		{/if}
	</div>

	{#snippet controls(close)}
		<Button kind="outline" onclick={close} disabled={isLoading}>关闭</Button>
		{#if auditState === "error"}
			<Button style="pop" onclick={runAudit}>重试</Button>
		{/if}
	{/snippet}
</Modal>

<style lang="postcss">
	.commit-audit-modal,
	.audit-report {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.audit-report {
		overflow-y: auto;
	}

	.audit-section {
		padding: 12px;
		border: 1px solid var(--border-2);
		border-radius: var(--radius-m);
	}

	h2,
	h3,
	p,
	ul,
	dl {
		margin: 0;
	}

	h2 {
		font-size: var(--font-size-14);
	}
	h3 {
		margin-top: 12px;
		font-size: var(--font-size-13);
	}
	ul {
		padding-left: 20px;
	}

	.metadata,
	.summary {
		display: grid;
		margin-top: 12px;
		gap: 8px;
	}

	dt {
		color: var(--text-2);
	}
	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
