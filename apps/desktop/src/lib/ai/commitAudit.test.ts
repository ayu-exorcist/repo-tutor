import {
	INSUFFICIENT_MOTIVATION,
	INSUFFICIENT_TRADEOFFS,
	CommitAuditValidationError,
	createCommitAuditContract,
	normalizeCommitIds,
	parseCommitAuditReport,
	renderCommitAuditPrompt,
	validateCommitAuditReport,
	type CommitAuditEvidence,
	type CommitAuditMaterial,
} from "$lib/ai/commitAudit";
import { describe, expect, test } from "vitest";

const oneCommitMaterial: CommitAuditMaterial = {
	commits: [
		{
			id: "abc123",
			message: "fix parser boundary",
			metadata: { author: "Ada", committedAt: "2026-08-19T00:00:00Z" },
			files: [
				{
					path: "src/parser.ts",
					patch: "@@ -1,1 +1,2 @@",
					hunks: [{ id: "abc123:src/parser.ts:0", header: "@@ -1,1 +1,2 @@", patch: "+guard" }],
				},
			],
		},
	],
	missingMaterials: ["Binary patch for assets/logo.png is unavailable."],
};

const twoCommitMaterial: CommitAuditMaterial = {
	...oneCommitMaterial,
	commits: [
		...oneCommitMaterial.commits,
		{
			id: "def456",
			message: "add parser test",
			metadata: { author: "Ada", committedAt: "2026-08-19T00:01:00Z" },
			files: [
				{
					path: "src/parser.test.ts",
					patch: "@@ -4,0 +5,1 @@",
					hunks: [{ id: "def456:src/parser.test.ts:0", header: "@@ -4,0 +5,1 @@", patch: "+test" }],
				},
			],
		},
	],
};

const evidence: CommitAuditEvidence = {
	kind: "hunk",
	commitId: "abc123",
	path: "src/parser.ts",
	hunk: "abc123:src/parser.ts:0",
};
const messageEvidence: CommitAuditEvidence = { kind: "message", commitId: "abc123" };

function fact(
	text = "解析器现在拒绝无效边界。",
	citedEvidence: CommitAuditEvidence[] = [evidence],
) {
	return { text, evidence: citedEvidence };
}

function inference(text = "(推测)该变更用于防止边界输入导致异常。") {
	return { isInference: true, text };
}

function changeCategories() {
	return ["bug修复"];
}

function adversarialReview() {
	return {
		hiddenAssumptions: inference("(推测)守卫依赖所有无效边界均会进入该分支。"),
		temporarySolution: inference("(推测)材料不足以确认该守卫是否为临时过渡方案。"),
	};
}

function commitReport(
	commitHash = "abc123",
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		commitHash,
		changeCategories: changeCategories(),
		objectiveChanges: [fact()],
		motivation: INSUFFICIENT_MOTIVATION,
		tradeoffs: INSUFFICIENT_TRADEOFFS,
		risks: [inference("(推测)缺少更广泛输入的回归覆盖。")],
		relatedClues: [],
		adversarialReview: adversarialReview(),
		squashWarning: inference("(推测)材料不足，无法判断是否应与相邻提交 squash。"),
		...overrides,
	};
}

function withHydratedMetadata(report: Record<string, unknown>): Record<string, unknown> {
	return {
		...report,
		commits: (report.commits as Record<string, unknown>[]).map((commit) => {
			const materialCommit = twoCommitMaterial.commits.find(
				(candidate) => candidate.id === commit.commitHash,
			);
			if (!materialCommit) throw new Error("test fixture must include commit material");
			return {
				...commit,
				metadata: {
					author: materialCommit.metadata.author,
					committedAt: materialCommit.metadata.committedAt,
					message: materialCommit.message,
				},
			};
		}),
	};
}

function evolutionSummary() {
	return {
		businessAndDesignGoals: inference("(推测)目标是使解析器边界行为可预测。"),
		iterationPath: inference("(推测)先加入守卫，再补充覆盖。"),
		tradeoffsAndDebt: inference("(推测)尚未看到性能权衡材料。"),
		unexplainedDecisions: inference("(推测)为何只覆盖该边界仍不明确。"),
		temporaryApproaches: inference("(推测)材料不足以确认是否存在临时方案。"),
	};
}

describe("commit audit contract", () => {
	test("normalizes duplicate commit IDs while preserving first-seen order", () => {
		expect(normalizeCommitIds([" abc123 ", "def456", "abc123", "", " def456 "])).toEqual([
			"abc123",
			"def456",
		]);
	});

	test("renders a JSON-only Chinese prompt with structural, squash, evidence, and cleanup rules", () => {
		const prompt = renderCommitAuditPrompt(oneCommitMaterial);

		expect(prompt).toContain("只输出一个可解析的 JSON 对象");
		expect(prompt).toContain("禁止 Markdown");
		expect(prompt).toContain("不要输出 metadata");
		expect(prompt).toContain('"kind":"hunk"');
		expect(prompt).toContain("只有 relatedClues 可以额外使用受限的 commit message evidence");
		expect(prompt).toContain("squashWarning 是每个 commit 的硬性必填字段");
		expect(prompt).toContain("清理 text 的首尾空白");
		expect(prompt).toContain("只根据下面提供的审计材料");
		expect(prompt).toContain("禁止 evolutionSummary 字段");
		expect(prompt).toContain(INSUFFICIENT_MOTIVATION);
		expect(prompt).toContain(
			"新功能、bug修复、代码重构、性能优化、依赖变更、文档调整、格式清理、热修复、其他",
		);
		expect(prompt).toContain("hiddenAssumptions");
		expect(prompt).toContain("temporarySolution");
	});

	test("exposes a small prompt-and-parse contract for callers", () => {
		const contract = createCommitAuditContract(oneCommitMaterial);
		const report = { commits: [commitReport()] };

		expect(contract.prompt).toContain("JSON");
		expect(contract.parse(JSON.stringify(report))).toEqual(withHydratedMetadata(report));
	});

	test("extracts one JSON object from fences and surrounding prose", () => {
		const report = {
			commits: [
				commitReport("abc123", {
					objectiveChanges: [fact("字符串中的 { 大括号 } 和 \\ 反斜线不应改变边界。")],
				}),
			],
		};
		const json = JSON.stringify(report);

		for (const raw of [
			json,
			`\`\`\`json\n${json}\n\`\`\``,
			`\`\`\`\n${json}\n\`\`\``,
			`审计结果如下：\n${json}\n以上。`,
		]) {
			expect(parseCommitAuditReport(raw, oneCommitMaterial)).toEqual(withHydratedMetadata(report));
		}
	});

	test("rejects incomplete, ambiguous, and non-object JSON responses", () => {
		const report = { commits: [commitReport()] };
		const json = JSON.stringify(report);

		for (const raw of [
			'{"commits":',
			`${json}\n${json}`,
			`\`\`\`json\n${json}\n\`\`\`\n\`\`\`\n${json}\n\`\`\``,
			"[]",
			JSON.stringify(json),
		]) {
			let error: unknown;
			try {
				parseCommitAuditReport(raw, oneCommitMaterial);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(CommitAuditValidationError);
			expect((error as CommitAuditValidationError).issues).toEqual(["response is not valid JSON"]);
		}
	});

	test("hydrates material metadata when model metadata is absent or different", () => {
		const withoutMetadata = { commits: [commitReport()] };
		expect(parseCommitAuditReport(JSON.stringify(withoutMetadata), oneCommitMaterial)).toEqual(
			withHydratedMetadata(withoutMetadata),
		);

		const withIncorrectMetadata = {
			commits: [
				commitReport("abc123", {
					metadata: { author: "Mallory", committedAt: "never", message: "incorrect" },
				}),
			],
		};
		expect(validateCommitAuditReport(withIncorrectMetadata, oneCommitMaterial)).toEqual(
			withHydratedMetadata(withIncorrectMetadata),
		);
	});

	test("requires all five evolution fields for multiple commits", () => {
		const reports = [commitReport(), commitReport("def456")];
		expect(() => validateCommitAuditReport({ commits: reports }, twoCommitMaterial)).toThrowError(
			/evolutionSummary is required and must contain all five fields/,
		);

		const report = { commits: reports, evolutionSummary: evolutionSummary() };
		expect(validateCommitAuditReport(report, twoCommitMaterial)).toEqual(
			withHydratedMetadata(report),
		);

		const { temporaryApproaches: _temporaryApproaches, ...incompleteEvolutionSummary } =
			evolutionSummary();
		expect(() =>
			validateCommitAuditReport(
				{ commits: reports, evolutionSummary: incompleteEvolutionSummary },
				twoCommitMaterial,
			),
		).toThrowError(/must contain all five fields/);
	});

	test("forbids an evolution summary for a single commit", () => {
		expect(() =>
			validateCommitAuditReport(
				{ commits: [commitReport()], evolutionSummary: evolutionSummary() },
				oneCommitMaterial,
			),
		).toThrowError(/must be omitted for a single commit/);
	});

	test("requires complete per-commit fields and validates change categories", () => {
		const { squashWarning: _squashWarning, ...missingField } = commitReport();
		expect(() =>
			validateCommitAuditReport({ commits: [missingField] }, oneCommitMaterial),
		).toThrowError(/commits\[0\]\.squashWarning must be a fact or an inference object/);

		expect(() =>
			validateCommitAuditReport(
				{ commits: [commitReport("abc123", { changeCategories: [] })] },
				oneCommitMaterial,
			),
		).toThrowError(/changeCategories must be a non-empty array/);
		expect(() =>
			validateCommitAuditReport(
				{ commits: [commitReport("abc123", { changeCategories: ["未知分类"] })] },
				oneCommitMaterial,
			),
		).toThrowError(/changeCategories\[0\] must be a known change category/);
		expect(() =>
			validateCommitAuditReport(
				{ commits: [commitReport("abc123", { changeCategories: ["bug修复", "bug修复"] })] },
				oneCommitMaterial,
			),
		).toThrowError(/must not contain duplicate change categories/);
	});

	test("normalizes adversarial review aliases and fills one missing field", () => {
		const aliasReport = {
			commits: [
				commitReport("abc123", {
					adversarialReview: {
						hiddenAssumption: adversarialReview().hiddenAssumptions,
						temporary: adversarialReview().temporarySolution,
					},
				}),
			],
		};
		expect(
			validateCommitAuditReport(aliasReport, oneCommitMaterial).commits[0]!.adversarialReview,
		).toEqual(adversarialReview());

		const partialReport = {
			commits: [
				commitReport("abc123", {
					adversarialReview: { temporarySolution: adversarialReview().temporarySolution },
				}),
			],
		};
		expect(
			validateCommitAuditReport(partialReport, oneCommitMaterial).commits[0]!.adversarialReview,
		).toEqual({
			hiddenAssumptions: { isInference: true, text: "(推测)【信息不足，无法推断】" },
			temporarySolution: adversarialReview().temporarySolution,
		});
	});

	test("rejects adversarial reviews with both fields missing, invalid statements, or unknown fields", () => {
		expect(() =>
			validateCommitAuditReport(
				{ commits: [commitReport("abc123", { adversarialReview: {} })] },
				oneCommitMaterial,
			),
		).toThrowError(/must contain hiddenAssumptions or temporarySolution/);
		expect(() =>
			validateCommitAuditReport(
				{
					commits: [
						commitReport("abc123", {
							adversarialReview: {
								hiddenAssumptions: "not a statement",
								temporarySolution: adversarialReview().temporarySolution,
							},
						}),
					],
				},
				oneCommitMaterial,
			),
		).toThrowError(/hiddenAssumptions must be a fact or an inference object/);
		expect(() =>
			validateCommitAuditReport(
				{
					commits: [
						commitReport("abc123", {
							adversarialReview: { ...adversarialReview(), unexpected: inference() },
						}),
					],
				},
				oneCommitMaterial,
			),
		).toThrowError(/adversarialReview contains unknown fields/);
	});

	test("enforces inference marker and exact insufficient-information sentinels", () => {
		expect(() =>
			validateCommitAuditReport(
				{
					commits: [
						commitReport("abc123", {
							motivation: "信息不足",
							tradeoffs: { isInference: true, text: "可能有取舍" },
						}),
					],
				},
				oneCommitMaterial,
			),
		).toThrowError(/motivation must be a fact or an inference object/);

		let error: unknown;
		try {
			validateCommitAuditReport(
				{
					commits: [
						commitReport("abc123", {
							motivation: inference("(推测)提交消息表明修复边界。"),
							tradeoffs: { isInference: true, text: "可能有取舍" },
						}),
					],
				},
				oneCommitMaterial,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CommitAuditValidationError);
		expect((error as CommitAuditValidationError).issues).toContain(
			"commits[0].tradeoffs inference text must start with (推测) and be non-empty",
		);
	});

	test("allows commit message evidence only for related clues", () => {
		const report = {
			commits: [
				commitReport("abc123", {
					relatedClues: [fact("提交信息表明存在解析器边界问题。", [messageEvidence])],
				}),
			],
		};
		expect(validateCommitAuditReport(report, oneCommitMaterial)).toEqual(
			withHydratedMetadata(report),
		);

		let error: unknown;
		try {
			validateCommitAuditReport(
				{
					commits: [
						commitReport("abc123", {
							objectiveChanges: [fact("消息不能证明目标变更。", [messageEvidence])],
							risks: [fact("消息不能证明风险。", [messageEvidence])],
							relatedClues: [
								fact("伪造 hunk。", [
									{
										kind: "hunk",
										commitId: "abc123",
										path: "src/other.ts",
										hunk: "fabricated",
									},
								]),
							],
						}),
					],
				},
				oneCommitMaterial,
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(CommitAuditValidationError);
		expect((error as CommitAuditValidationError).issues).toEqual(
			expect.arrayContaining([
				"commits[0].objectiveChanges[0].evidence[0] message evidence is only allowed in relatedClues",
				"commits[0].risks[0].evidence[0] message evidence is only allowed in relatedClues",
				"commits[0].relatedClues[0].evidence[0] is not in the audit material",
			]),
		);
	});

	test("rejects missing, unknown, and duplicate commit reports", () => {
		expect(() => validateCommitAuditReport({ commits: [] }, oneCommitMaterial)).toThrowError(
			/missing report for abc123/,
		);
		expect(() =>
			validateCommitAuditReport({ commits: [commitReport("unknown")] }, oneCommitMaterial),
		).toThrowError(/commitHash is not a normalized input commit/);
		expect(() =>
			validateCommitAuditReport({ commits: [commitReport(), commitReport()] }, oneCommitMaterial),
		).toThrowError(/contains duplicate reports for abc123/);
	});
});
