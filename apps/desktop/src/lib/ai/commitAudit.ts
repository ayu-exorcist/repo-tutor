export const COMMIT_AUDIT_CHANGE_CATEGORIES = [
	"新功能",
	"bug修复",
	"代码重构",
	"性能优化",
	"依赖变更",
	"文档调整",
	"格式清理",
	"热修复",
	"其他",
] as const;

export type CommitAuditChangeCategory = (typeof COMMIT_AUDIT_CHANGE_CATEGORIES)[number];

export const INSUFFICIENT_MOTIVATION = "【信息不足，无法推断】";
export const INSUFFICIENT_TRADEOFFS = "【无足够信息推断取舍】";

export interface CommitAuditHunkMaterial {
	/** Stable identifier used by the model when citing evidence. */
	id: string;
	header: string;
	patch: string;
}

export interface CommitAuditFileMaterial {
	path: string;
	patch: string;
	hunks?: CommitAuditHunkMaterial[];
}

export interface CommitAuditCommitMaterial {
	id: string;
	message: string;
	/** Commit metadata retained with the material sent to the model. */
	metadata: Record<string, unknown>;
	files: CommitAuditFileMaterial[];
}

export interface CommitAuditMaterial {
	commits: CommitAuditCommitMaterial[];
	/** Explains unavailable commit metadata, files, patches, or hunks. */
	missingMaterials: string[];
}

export interface CommitAuditEvidence {
	commitId: string;
	path: string;
	hunk: string;
}

/** A claim established by supplied material and backed by precise evidence. */
export interface CommitAuditFact {
	text: string;
	evidence: CommitAuditEvidence[];
}

/** A claim which cannot be established by supplied material. */
export interface CommitAuditInference {
	isInference: true;
	text: string;
}

export type CommitAuditStatement = CommitAuditFact | CommitAuditInference;

export interface CommitAuditAdversarialReview {
	hiddenAssumptions: CommitAuditStatement;
	temporarySolution: CommitAuditStatement;
}

export interface CommitAuditMetadata {
	author: unknown;
	committedAt: unknown;
	message: string;
}

/** The required audit fields for exactly one normalized input commit. */
export interface CommitAuditCommitReport {
	commitHash: string;
	metadata: CommitAuditMetadata;
	changeCategories: CommitAuditChangeCategory[];
	/** Every objective change is material-backed rather than inferred. */
	objectiveChanges: CommitAuditFact[];
	motivation: CommitAuditStatement | typeof INSUFFICIENT_MOTIVATION;
	tradeoffs: CommitAuditStatement | typeof INSUFFICIENT_TRADEOFFS;
	risks: CommitAuditStatement[];
	relatedClues: CommitAuditStatement[];
	adversarialReview: CommitAuditAdversarialReview;
	/** Always assess whether the commit should be squashed; never omit this field. */
	squashWarning: CommitAuditStatement;
}

export interface CommitAuditEvolutionSummary {
	businessAndDesignGoals: CommitAuditStatement;
	iterationPath: CommitAuditStatement;
	tradeoffsAndDebt: CommitAuditStatement;
	unexplainedDecisions: CommitAuditStatement;
	temporaryApproaches: CommitAuditStatement;
}

export interface CommitAuditReport {
	commits: CommitAuditCommitReport[];
	/** Required for multiple normalized commits and forbidden for a single commit. */
	evolutionSummary?: CommitAuditEvolutionSummary;
}

/** Small boundary for a caller that renders one prompt and parses its response. */
export interface CommitAuditContract {
	prompt: string;
	parse(raw: string): CommitAuditReport;
}

export class CommitAuditValidationError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid commit audit report: ${issues.join("; ")}`);
		this.name = "CommitAuditValidationError";
		this.issues = issues;
	}
}

/** Trims IDs, removes empty IDs, and keeps the first occurrence of each ID. */
export function normalizeCommitIds(ids: readonly string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();

	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			normalized.push(trimmed);
		}
	}

	return normalized;
}

export function createCommitAuditContract(material: CommitAuditMaterial): CommitAuditContract {
	return {
		prompt: renderCommitAuditPrompt(material),
		parse: (raw) => parseCommitAuditReport(raw, material),
	};
}

/**
 * Builds the model-facing contract. The material is JSON so the model can only cite
 * commits, paths, and hunks that are visible in this request.
 */
export function renderCommitAuditPrompt(material: CommitAuditMaterial): string {
	assertMaterial(material);
	const commitIds = normalizeCommitIds(material.commits.map((commit) => commit.id));

	return `你是一个严格的逐 commit 代码审计助手。请只根据下面提供的审计材料判断，不要补造材料。

硬性约束：
1. 只输出一个可解析的 JSON 对象；禁止 Markdown、代码围栏、解释文字或前后缀。
2. 顶层必须是 {"commits":[...]}。每个规范化后的输入 commit ID 必须恰好对应一个 report：不得多、漏、重复，也不得使用未知 commitHash。
3. 每个 commit report 必须完整包含：commitHash、metadata{author,committedAt,message}、changeCategories、objectiveChanges、motivation、tradeoffs、risks、relatedClues、adversarialReview、squashWarning。metadata 的三个值必须逐字复用材料中该 commit 的 author、committedAt、message。
4. changeCategories 必须是非空数组；每个值只能从以下 9 个中文分类中选择，且不得重复：${COMMIT_AUDIT_CHANGE_CATEGORIES.join("、")}。
5. objectiveChanges 是非空数组；每项都是 {"text":"...","evidence":[...]}，evidence 不得为空。任何由材料可以验证的事实都使用这个格式。risk items 及其他带 evidence 的事实也必须使用相同格式。
6. 每条 evidence 的 commitId、path、hunk 必须逐字来自审计材料的同一条 commit/file/hunk；不得引用 missingMaterials 或不存在的材料。
7. 无法由材料建立的判断只能使用 {"isInference":true,"text":"(推测)..."}；text 必须以精确前缀 "(推测)" 开头，且推断对象不得附带 evidence。不要把未验证判断伪装成事实。
8. motivation 只能是有证据事实、合规推断，或精确 sentinel "${INSUFFICIENT_MOTIVATION}"；tradeoffs 只能是有证据事实、合规推断，或精确 sentinel "${INSUFFICIENT_TRADEOFFS}"。
9. adversarialReview 必须是只包含 hiddenAssumptions 和 temporarySolution 的对象。hiddenAssumptions 审查隐性前提不成立的后果；temporarySolution 审查是否是临时过渡方案及其后续重构暗示。两项都必须是合规的事实或推断对象。
10. squashWarning 是每个 commit 的硬性必填字段：必须明确审视是否应 squash；只有材料证据支持时才作事实性建议，否则使用合规推断，绝不能省略或编造 squash 历史。
11. 仅一个不同的 commit ID 时，禁止 evolutionSummary 字段（不是空对象，而是完全省略）。两个或更多不同的 commit ID 时，必须输出 evolutionSummary 对象，并完整包含 businessAndDesignGoals、iterationPath、tradeoffsAndDebt、unexplainedDecisions、temporaryApproaches 五项；每项同样遵循事实证据或推断标记规则。
12. 清理 text 的首尾空白，保持简短直接；不要输出 Markdown、编号、分类外标签或材料外上下文。missingMaterials 只说明不可用内容，不能充当证据。

输出骨架（仅示意；所有文本和证据必须来自真实材料）：
{"commits":[{"commitHash":"<材料 commit ID>","metadata":{"author":"<材料 metadata.author>","committedAt":"<材料 metadata.committedAt>","message":"<材料 message>"},"changeCategories":["bug修复"],"objectiveChanges":[{"text":"...","evidence":[{"commitId":"<材料 commit ID>","path":"<材料路径>","hunk":"<材料 hunk id>"}]}],"motivation":"${INSUFFICIENT_MOTIVATION}","tradeoffs":"${INSUFFICIENT_TRADEOFFS}","risks":[],"relatedClues":[],"adversarialReview":{"hiddenAssumptions":{"isInference":true,"text":"(推测)..."},"temporarySolution":{"isInference":true,"text":"(推测)..."}},"squashWarning":{"isInference":true,"text":"(推测)..."}}],"evolutionSummary":{"businessAndDesignGoals":{"isInference":true,"text":"(推测)..."},"iterationPath":{"isInference":true,"text":"(推测)..."},"tradeoffsAndDebt":{"isInference":true,"text":"(推测)..."},"unexplainedDecisions":{"isInference":true,"text":"(推测)..."},"temporaryApproaches":{"isInference":true,"text":"(推测)..."}}}

规范化后的 commit IDs（仅用于一对一报告与演进规则；evidence 仍须引用原始材料中的 ID）：
${JSON.stringify(commitIds)}

审计材料：
${JSON.stringify(material)}`;
}

/** Parses and validates the raw JSON returned by a model. */
export function parseCommitAuditReport(
	raw: string,
	material: CommitAuditMaterial,
): CommitAuditReport {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new CommitAuditValidationError(["response is not valid JSON"]);
	}

	return validateCommitAuditReport(value, material);
}

/** Runtime validation boundary for untrusted model output. */
export function validateCommitAuditReport(
	value: unknown,
	material: CommitAuditMaterial,
): CommitAuditReport {
	assertMaterial(material);
	if (!isRecord(value)) throw new CommitAuditValidationError(["report must be a JSON object"]);

	const issues: string[] = [];
	const commitIds = normalizeCommitIds(material.commits.map((commit) => commit.id));
	if (!hasOnlyKeys(value, ["commits", "evolutionSummary"])) {
		issues.push("report contains unknown fields");
	}
	if (!Array.isArray(value.commits)) {
		issues.push("commits must be an array");
	} else {
		validateCommitReports(value.commits, commitIds, material, issues);
	}

	const hasEvolutionSummary = Object.prototype.hasOwnProperty.call(value, "evolutionSummary");
	if (commitIds.length === 1 && hasEvolutionSummary) {
		issues.push("evolutionSummary must be omitted for a single commit");
	} else if (commitIds.length > 1) {
		validateEvolutionSummary(value.evolutionSummary, material, issues);
	}

	if (issues.length > 0) throw new CommitAuditValidationError(issues);
	return value as unknown as CommitAuditReport;
}

function validateCommitReports(
	reports: unknown[],
	commitIds: readonly string[],
	material: CommitAuditMaterial,
	issues: string[],
): void {
	const reportCounts = new Map<string, number>();

	reports.forEach((report, index) => {
		const path = `commits[${index}]`;
		if (!isRecord(report)) {
			issues.push(`${path} must be an object`);
			return;
		}
		if (
			!hasOnlyKeys(report, [
				"commitHash",
				"metadata",
				"changeCategories",
				"objectiveChanges",
				"motivation",
				"tradeoffs",
				"risks",
				"relatedClues",
				"adversarialReview",
				"squashWarning",
			])
		) {
			issues.push(`${path} contains unknown fields`);
		}
		if (typeof report.commitHash !== "string" || !report.commitHash.trim()) {
			issues.push(`${path}.commitHash must be a non-empty string`);
			return;
		}

		reportCounts.set(report.commitHash, (reportCounts.get(report.commitHash) ?? 0) + 1);
		const materialCommit = material.commits.find((commit) => commit.id === report.commitHash);
		if (!commitIds.includes(report.commitHash) || !materialCommit) {
			issues.push(`${path}.commitHash is not a normalized input commit`);
			return;
		}

		validateMetadata(report.metadata, materialCommit, `${path}.metadata`, issues);
		validateChangeCategories(report.changeCategories, `${path}.changeCategories`, issues);
		validateStatementArray(
			report.objectiveChanges,
			`${path}.objectiveChanges`,
			material,
			issues,
			true,
			true,
		);
		validateSentinelOrStatement(
			report.motivation,
			INSUFFICIENT_MOTIVATION,
			`${path}.motivation`,
			material,
			issues,
		);
		validateSentinelOrStatement(
			report.tradeoffs,
			INSUFFICIENT_TRADEOFFS,
			`${path}.tradeoffs`,
			material,
			issues,
		);
		validateStatementArray(report.risks, `${path}.risks`, material, issues);
		validateStatementArray(report.relatedClues, `${path}.relatedClues`, material, issues);
		validateAdversarialReview(
			report.adversarialReview,
			`${path}.adversarialReview`,
			material,
			issues,
		);
		validateStatement(report.squashWarning, `${path}.squashWarning`, material, issues);
	});

	for (const commitId of commitIds) {
		const count = reportCounts.get(commitId) ?? 0;
		if (count === 0) issues.push(`commits is missing report for ${commitId}`);
		if (count > 1) issues.push(`commits contains duplicate reports for ${commitId}`);
	}
}

function validateMetadata(
	value: unknown,
	materialCommit: CommitAuditCommitMaterial,
	path: string,
	issues: string[],
): void {
	if (!isRecord(value) || !hasExactKeys(value, ["author", "committedAt", "message"])) {
		issues.push(`${path} must contain exactly author, committedAt, and message`);
		return;
	}
	if (typeof value.message !== "string" || !value.message.trim()) {
		issues.push(`${path}.message must be a non-empty string`);
	}
	if (
		!areJsonValuesEqual(value.author, materialCommit.metadata.author) ||
		!areJsonValuesEqual(value.committedAt, materialCommit.metadata.committedAt) ||
		value.message !== materialCommit.message
	) {
		issues.push(`${path} must exactly match the commit material`);
	}
}

function validateChangeCategories(value: unknown, path: string, issues: string[]): void {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push(`${path} must be a non-empty array`);
		return;
	}

	const seen = new Set<string>();
	value.forEach((category, index) => {
		if (
			typeof category !== "string" ||
			!COMMIT_AUDIT_CHANGE_CATEGORIES.includes(category as CommitAuditChangeCategory)
		) {
			issues.push(`${path}[${index}] must be a known change category`);
			return;
		}
		if (seen.has(category)) {
			issues.push(`${path} must not contain duplicate change categories`);
			return;
		}
		seen.add(category);
	});
}

function validateAdversarialReview(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
): void {
	const fields = ["hiddenAssumptions", "temporarySolution"] as const;
	if (!isRecord(value) || !hasExactKeys(value, fields)) {
		issues.push(`${path} must contain exactly hiddenAssumptions and temporarySolution`);
		return;
	}
	for (const field of fields) validateStatement(value[field], `${path}.${field}`, material, issues);
}

function validateEvolutionSummary(
	value: unknown,
	material: CommitAuditMaterial,
	issues: string[],
): void {
	const path = "evolutionSummary";
	const fields = [
		"businessAndDesignGoals",
		"iterationPath",
		"tradeoffsAndDebt",
		"unexplainedDecisions",
		"temporaryApproaches",
	] as const;
	if (!isRecord(value) || !hasExactKeys(value, fields)) {
		issues.push(
			"evolutionSummary is required and must contain all five fields for multiple commits",
		);
		return;
	}
	for (const field of fields) validateStatement(value[field], `${path}.${field}`, material, issues);
}

function validateSentinelOrStatement(
	value: unknown,
	sentinel: string,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
): void {
	if (value === sentinel) return;
	validateStatement(value, path, material, issues);
}

function validateStatementArray(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
	requireEvidence = false,
	requireNonEmpty = false,
): void {
	if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
		issues.push(`${path} must be${requireNonEmpty ? " a non-empty" : " an"} array`);
		return;
	}
	value.forEach((item, index) =>
		validateStatement(item, `${path}[${index}]`, material, issues, requireEvidence),
	);
}

function validateStatement(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
	requireEvidence = false,
): void {
	if (!isRecord(value)) {
		issues.push(`${path} must be a fact or an inference object`);
		return;
	}
	if (value.isInference === true) {
		if (!hasOnlyKeys(value, ["isInference", "text"])) {
			issues.push(`${path} inference contains unknown fields`);
		}
		if (
			typeof value.text !== "string" ||
			!value.text.startsWith("(推测)") ||
			value.text.length === 4
		) {
			issues.push(`${path} inference text must start with (推测) and be non-empty`);
		}
		if (requireEvidence) issues.push(`${path} must be backed by evidence, not an inference`);
		return;
	}
	if (!hasOnlyKeys(value, ["text", "evidence"])) {
		issues.push(`${path} fact must contain only text and evidence`);
	}
	if (typeof value.text !== "string" || !value.text.trim()) {
		issues.push(`${path}.text must be a non-empty string`);
	}
	if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
		issues.push(`${path}.evidence must be a non-empty array`);
		return;
	}
	value.evidence.forEach((evidence, index) =>
		validateEvidence(evidence, `${path}.evidence[${index}]`, material, issues),
	);
}

function validateEvidence(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
): void {
	if (!isRecord(value) || !hasOnlyKeys(value, ["commitId", "path", "hunk"])) {
		issues.push(`${path} has an invalid shape`);
		return;
	}
	if (
		typeof value.commitId !== "string" ||
		typeof value.path !== "string" ||
		typeof value.hunk !== "string"
	) {
		issues.push(`${path} must cite strings`);
		return;
	}
	if (!isKnownEvidence(value, material)) issues.push(`${path} is not in the audit material`);
}

function isKnownEvidence(
	evidence: Record<string, unknown>,
	material: CommitAuditMaterial,
): boolean {
	const commit = material.commits.find((candidate) => candidate.id === evidence.commitId);
	const file = commit?.files.find((candidate) => candidate.path === evidence.path);
	return !!file?.hunks?.some((hunk) => hunk.id === evidence.hunk);
}

function assertMaterial(material: CommitAuditMaterial): void {
	if (
		!isRecord(material) ||
		!Array.isArray(material.commits) ||
		!Array.isArray(material.missingMaterials)
	) {
		throw new CommitAuditValidationError(["audit material has an invalid shape"]);
	}
	const issues: string[] = [];
	if (material.commits.length === 0) issues.push("audit material must include at least one commit");
	if (!material.missingMaterials.every((description) => typeof description === "string")) {
		issues.push("missingMaterials must contain only strings");
	}
	for (const [index, commit] of material.commits.entries()) {
		if (!isRecord(commit) || typeof commit.id !== "string" || !commit.id.trim()) {
			issues.push(`commits[${index}].id must be non-empty`);
			continue;
		}
		if (
			typeof commit.message !== "string" ||
			!isRecord(commit.metadata) ||
			!Array.isArray(commit.files)
		) {
			issues.push(`commits[${index}] must include message, metadata, and files`);
			continue;
		}
		for (const [fileIndex, file] of commit.files.entries()) {
			if (!isRecord(file) || typeof file.path !== "string" || typeof file.patch !== "string") {
				issues.push(`commits[${index}].files[${fileIndex}] must include path and patch`);
				continue;
			}
			if (file.hunks !== undefined && !Array.isArray(file.hunks)) {
				issues.push(`commits[${index}].files[${fileIndex}].hunks must be an array`);
				continue;
			}
			for (const [hunkIndex, hunk] of (file.hunks ?? []).entries()) {
				if (
					!isRecord(hunk) ||
					typeof hunk.id !== "string" ||
					typeof hunk.header !== "string" ||
					typeof hunk.patch !== "string"
				) {
					issues.push(`commits[${index}].files[${fileIndex}].hunks[${hunkIndex}] is invalid`);
				}
			}
		}
	}
	if (issues.length > 0) throw new CommitAuditValidationError(issues);
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => areJsonValuesEqual(item, right[index]))
		);
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key) =>
					Object.prototype.hasOwnProperty.call(right, key) &&
					areJsonValuesEqual(left[key], right[key]),
			)
		);
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}
