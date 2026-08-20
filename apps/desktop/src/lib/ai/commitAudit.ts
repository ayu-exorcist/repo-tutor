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

export interface CommitAuditHunkEvidence {
	kind: "hunk";
	commitId: string;
	path: string;
	hunk: string;
}

/** A restricted citation of a supplied commit message, allowed only for related clues. */
export interface CommitAuditMessageEvidence {
	kind: "message";
	commitId: string;
}

export type CommitAuditEvidence = CommitAuditHunkEvidence | CommitAuditMessageEvidence;

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
 * visible commits, paths and hunks, or a visible commit message for related clues.
 */
export function renderCommitAuditPrompt(material: CommitAuditMaterial): string {
	assertMaterial(material);
	const commitIds = normalizeCommitIds(material.commits.map((commit) => commit.id));

	return `你是一个严格的逐 commit 代码审计助手。请只根据下面提供的审计材料判断，不要补造材料。

硬性约束：
1. 只输出一个可解析的 JSON 对象；禁止 Markdown、代码围栏、解释文字或前后缀。
2. 顶层必须是 {"commits":[...]}。每个规范化后的输入 commit ID 必须恰好对应一个 report：不得多、漏、重复，也不得使用未知 commitHash。
3. 每个 commit report 必须完整包含：commitHash、changeCategories、objectiveChanges、motivation、tradeoffs、risks、relatedClues、adversarialReview、squashWarning。不要输出 metadata；它由调用方根据审计材料本地补充。
4. changeCategories 必须是非空数组；每个值只能从以下 9 个中文分类中选择，且不得重复：${COMMIT_AUDIT_CHANGE_CATEGORIES.join("、")}。
5. objectiveChanges 是非空数组；每项都是 {"text":"...","evidence":[...]}，evidence 不得为空。任何由材料可以验证的事实都使用这个格式。risk items 及其他带 evidence 的事实也必须使用相同格式。
6. hunk evidence 必须是 {"kind":"hunk","commitId":"...","path":"...","hunk":"..."}，其 commitId、path、hunk 必须逐字来自审计材料的同一条 commit/file/hunk。只有 relatedClues 可以额外使用受限的 commit message evidence：{"kind":"message","commitId":"..."}，commitId 必须来自审计材料；其他字段不得使用 message evidence。不得引用 missingMaterials 或不存在的材料。
7. 无法由材料建立的判断只能使用 {"isInference":true,"text":"(推测)..."}；text 必须以精确前缀 "(推测)" 开头，且推断对象不得附带 evidence。不要把未验证判断伪装成事实。
8. motivation 只能是有证据事实、合规推断，或精确 sentinel "${INSUFFICIENT_MOTIVATION}"；tradeoffs 只能是有证据事实、合规推断，或精确 sentinel "${INSUFFICIENT_TRADEOFFS}"。
9. adversarialReview 必须只使用规范字段 hiddenAssumptions 和 temporarySolution。hiddenAssumptions 审查隐性前提不成立的后果；temporarySolution 审查是否是临时过渡方案及其后续重构暗示。两项都必须是合规的事实或推断对象。
10. squashWarning 是每个 commit 的硬性必填字段：必须明确审视是否应 squash；只有材料证据支持时才作事实性建议，否则使用合规推断，绝不能省略或编造 squash 历史。
11. 仅一个不同的 commit ID 时，禁止 evolutionSummary 字段（不是空对象，而是完全省略）。两个或更多不同的 commit ID 时，必须输出 evolutionSummary 对象，并完整包含 businessAndDesignGoals、iterationPath、tradeoffsAndDebt、unexplainedDecisions、temporaryApproaches 五项；每项同样遵循事实证据或推断标记规则。
12. 清理 text 的首尾空白，保持简短直接；不要输出 Markdown、编号、分类外标签或材料外上下文。missingMaterials 只说明不可用内容，不能充当证据。

输出骨架（仅示意；所有文本和证据必须来自真实材料）：
{"commits":[{"commitHash":"<材料 commit ID>","changeCategories":["bug修复"],"objectiveChanges":[{"text":"...","evidence":[{"kind":"hunk","commitId":"<材料 commit ID>","path":"<材料路径>","hunk":"<材料 hunk id>"}]}],"motivation":"${INSUFFICIENT_MOTIVATION}","tradeoffs":"${INSUFFICIENT_TRADEOFFS}","risks":[],"relatedClues":[],"adversarialReview":{"hiddenAssumptions":{"isInference":true,"text":"(推测)..."},"temporarySolution":{"isInference":true,"text":"(推测)..."}},"squashWarning":{"isInference":true,"text":"(推测)..."}}],"evolutionSummary":{"businessAndDesignGoals":{"isInference":true,"text":"(推测)..."},"iterationPath":{"isInference":true,"text":"(推测)..."},"tradeoffsAndDebt":{"isInference":true,"text":"(推测)..."},"unexplainedDecisions":{"isInference":true,"text":"(推测)..."},"temporaryApproaches":{"isInference":true,"text":"(推测)..."}}}

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
	return validateCommitAuditReport(extractUniqueJsonObject(raw), material);
}

/** Extracts exactly one complete JSON object while tolerating surrounding model prose or fences. */
function extractUniqueJsonObject(raw: string): Record<string, unknown> {
	const trimmed = raw.trim();
	const candidates: Record<string, unknown>[] = [];
	if (!trimmed || trimmed.startsWith("[") || isWholeJsonString(trimmed)) {
		throwInvalidJsonResponse();
	}

	for (let start = 0; start < raw.length; start += 1) {
		if (raw[start] !== "{") continue;

		const end = findJsonObjectEnd(raw, start);
		if (end === undefined) throwInvalidJsonResponse();

		let candidate: unknown;
		try {
			candidate = JSON.parse(raw.slice(start, end));
		} catch {
			throwInvalidJsonResponse();
		}
		if (!isRecord(candidate)) throwInvalidJsonResponse();

		candidates.push(candidate);
		start = end - 1;
	}

	if (candidates.length !== 1) throwInvalidJsonResponse();
	return candidates[0]!;
}

function isWholeJsonString(value: string): boolean {
	if (value[0] !== '"') return false;

	let isEscaped = false;
	for (let index = 1; index < value.length; index += 1) {
		const character = value[index]!;
		if (isEscaped) {
			isEscaped = false;
		} else if (character === "\\") {
			isEscaped = true;
		} else if (character === '"') {
			return index === value.length - 1;
		}
	}

	return false;
}

/** Finds the end of an object while respecting JSON strings, escapes, and nested arrays/objects. */
function findJsonObjectEnd(raw: string, start: number): number | undefined {
	const expectedClosers: ("}" | "]")[] = [];
	let inString = false;
	let isEscaped = false;

	for (let index = start; index < raw.length; index += 1) {
		const character = raw[index]!;
		if (inString) {
			if (isEscaped) {
				isEscaped = false;
			} else if (character === "\\") {
				isEscaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
		} else if (character === "{") {
			expectedClosers.push("}");
		} else if (character === "[") {
			expectedClosers.push("]");
		} else if (character === "}" || character === "]") {
			if (expectedClosers.pop() !== character) return undefined;
			if (expectedClosers.length === 0) return index + 1;
		}
	}

	return undefined;
}

function throwInvalidJsonResponse(): never {
	throw new CommitAuditValidationError(["response is not valid JSON"]);
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
	return hydrateCommitAuditMetadata(value, material);
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
		validateStatementArray(
			report.relatedClues,
			`${path}.relatedClues`,
			material,
			issues,
			false,
			false,
			true,
		);
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

function hydrateCommitAuditMetadata(
	value: Record<string, unknown>,
	material: CommitAuditMaterial,
): CommitAuditReport {
	return {
		...value,
		commits: (value.commits as Record<string, unknown>[]).map((report) => {
			const materialCommit = material.commits.find((commit) => commit.id === report.commitHash);
			if (!materialCommit) throw new Error("validated commit report is missing material");
			const { metadata: _discardedMetadata, ...modelReport } = report;
			return {
				...modelReport,
				metadata: {
					author: materialCommit.metadata.author,
					committedAt: materialCommit.metadata.committedAt,
					message: materialCommit.message,
				},
			};
		}),
	} as unknown as CommitAuditReport;
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
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}

	const aliases = {
		hiddenAssumptions: "hiddenAssumptions",
		hiddenAssumption: "hiddenAssumptions",
		temporarySolution: "temporarySolution",
		temporary: "temporarySolution",
	} as const;
	const normalized: Partial<Record<(typeof fields)[number], unknown>> = {};
	for (const [key, statement] of Object.entries(value)) {
		const field = aliases[key as keyof typeof aliases];
		if (!field) {
			issues.push(`${path} contains unknown fields`);
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(normalized, field)) {
			issues.push(`${path} must not contain duplicate ${field} fields`);
			continue;
		}
		normalized[field] = statement;
	}

	const hasHiddenAssumptions = normalized.hiddenAssumptions !== undefined;
	const hasTemporarySolution = normalized.temporarySolution !== undefined;
	if (!hasHiddenAssumptions && !hasTemporarySolution) {
		issues.push(`${path} must contain hiddenAssumptions or temporarySolution`);
		return;
	}
	if (!hasHiddenAssumptions)
		normalized.hiddenAssumptions = insufficientAdversarialReviewStatement();
	if (!hasTemporarySolution)
		normalized.temporarySolution = insufficientAdversarialReviewStatement();

	value.hiddenAssumptions = normalized.hiddenAssumptions;
	value.temporarySolution = normalized.temporarySolution;
	delete value.hiddenAssumption;
	delete value.temporary;
	for (const field of fields) validateStatement(value[field], `${path}.${field}`, material, issues);
}

function insufficientAdversarialReviewStatement(): CommitAuditInference {
	return { isInference: true, text: "(推测)【信息不足，无法推断】" };
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
	allowMessageEvidence = false,
): void {
	if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
		issues.push(`${path} must be${requireNonEmpty ? " a non-empty" : " an"} array`);
		return;
	}
	value.forEach((item, index) =>
		validateStatement(
			item,
			`${path}[${index}]`,
			material,
			issues,
			requireEvidence,
			allowMessageEvidence,
		),
	);
}

function validateStatement(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
	requireEvidence = false,
	allowMessageEvidence = false,
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
		validateEvidence(
			evidence,
			`${path}.evidence[${index}]`,
			material,
			issues,
			allowMessageEvidence,
		),
	);
}

function validateEvidence(
	value: unknown,
	path: string,
	material: CommitAuditMaterial,
	issues: string[],
	allowMessageEvidence: boolean,
): void {
	if (!isRecord(value) || typeof value.kind !== "string") {
		issues.push(`${path} has an invalid shape`);
		return;
	}
	if (value.kind === "message") {
		if (!hasExactKeys(value, ["kind", "commitId"])) {
			issues.push(`${path} has an invalid shape`);
			return;
		}
		if (typeof value.commitId !== "string") {
			issues.push(`${path} must cite strings`);
			return;
		}
		if (!isKnownMessageEvidence(value, material)) {
			issues.push(`${path} is not in the audit material`);
		}
		if (!allowMessageEvidence) {
			issues.push(`${path} message evidence is only allowed in relatedClues`);
		}
		return;
	}
	if (value.kind !== "hunk" || !hasExactKeys(value, ["kind", "commitId", "path", "hunk"])) {
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
	if (!isKnownHunkEvidence(value, material)) issues.push(`${path} is not in the audit material`);
}

function isKnownMessageEvidence(
	evidence: Record<string, unknown>,
	material: CommitAuditMaterial,
): boolean {
	return material.commits.some((commit) => commit.id === evidence.commitId);
}

function isKnownHunkEvidence(
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
