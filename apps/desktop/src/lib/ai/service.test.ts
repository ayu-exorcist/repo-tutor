import { AnthropicAIClient } from "$lib/ai/anthropicClient";
import { BackendAiClient } from "$lib/ai/backendAiClient";
import { ButlerAIClient } from "$lib/ai/butlerClient";
import {
	CommitAuditValidationError,
	INSUFFICIENT_MOTIVATION,
	INSUFFICIENT_TRADEOFFS,
	type CommitAuditMaterial,
} from "$lib/ai/commitAudit";
import { OpenAIClient } from "$lib/ai/openAIClient";
import {
	SHORT_DEFAULT_BRANCH_TEMPLATE,
	SHORT_DEFAULT_COMMIT_TEMPLATE,
	SHORT_DEFAULT_PR_TEMPLATE,
} from "$lib/ai/prompts";
import {
	AISecretHandle,
	AIService,
	GitAIConfigKey,
	KeyOption,
	buildDiff,
	type DiffInput,
} from "$lib/ai/service";
import {
	AnthropicModelName,
	MessageRole,
	ModelKind,
	OpenAIModelName,
	type AIClient,
	type Prompt,
} from "$lib/ai/types";
import { GitConfigService } from "$lib/config/gitConfigService";
import type { IBackend } from "$lib/backend/backend";
import { mockCreateBackend } from "$lib/testing/mockBackend";
import { TokenMemoryService } from "$lib/user/tokenMemoryService";
import { HttpClient } from "@gitbutler/shared/network/httpClient";
import { expect, test, describe, vi } from "vitest";
import type { SecretsService } from "$lib/secrets/secretsService";
import type { AppDispatch } from "$lib/state/clientState.svelte";
import type { GitConfigSettings } from "@gitbutler/but-sdk";

const dummyBackend = {} as IBackend;

const defaultGitConfig = Object.freeze({
	[GitAIConfigKey.ModelProvider]: ModelKind.OpenAI,
	[GitAIConfigKey.OpenAIKeyOption]: KeyOption.ButlerAPI,
	[GitAIConfigKey.OpenAIModelName]: OpenAIModelName.GPT54Nano,
	[GitAIConfigKey.AnthropicKeyOption]: KeyOption.ButlerAPI,
	[GitAIConfigKey.AnthropicModelName]: AnthropicModelName.Haiku,
});

const defaultSecretsConfig = Object.freeze({
	[AISecretHandle.AnthropicKey]: undefined,
	[AISecretHandle.OpenAIKey]: undefined,
	[AISecretHandle.OpenRouterKey]: undefined,
});

class DummyGitConfigService extends GitConfigService {
	constructor(private config: { [index: string]: string | undefined }) {
		const backend = mockCreateBackend();
		const MockBackendApi = vi.fn();
		MockBackendApi.prototype.injectEndpoints = vi.fn();
		const mockBackendApi = new MockBackendApi();
		super(mockBackendApi, vi.fn() as unknown as AppDispatch, backend);
	}
	async getGbConfig(_projectId: string): Promise<GitConfigSettings> {
		throw new Error("Method not implemented.");
	}
	async setGbConfig(_projectId: string, _config: GitConfigSettings): Promise<void> {
		throw new Error("Method not implemented.");
	}
	async get<T extends string>(key: string): Promise<T | undefined> {
		return (this.config[key] || undefined) as T | undefined;
	}

	async getWithDefault<T extends string>(key: string): Promise<T> {
		return this.config[key] as T;
	}

	async set<T extends string>(key: string, value: T): Promise<T | undefined> {
		return (this.config[key] = value);
	}
	async remove(key: string): Promise<undefined> {
		delete this.config[key];
	}
	async checkGitFetch(_projectId: string, _remoteName: string | null | undefined): Promise<void> {
		throw new Error("Method not implemented.");
	}
	async checkGitPush(
		_projectId: string,
		_remoteName: string | null | undefined,
		_branchName: string | null | undefined,
	): Promise<{ name: string; ok: boolean } | undefined> {
		throw new Error("Method not implemented.");
	}
}

class DummySecretsService implements SecretsService {
	private config: { [index: string]: string | undefined };
	constructor(config?: { [index: string]: string | undefined }) {
		this.config = config || {};
	}

	async get(key: string): Promise<string | undefined> {
		return this.config[key];
	}

	async set(handle: string, secret: string): Promise<void> {
		this.config[handle] = secret;
	}

	async delete(handle: string): Promise<void> {
		delete this.config[handle];
	}
}

class DummyAIClient implements AIClient {
	defaultCommitTemplate = SHORT_DEFAULT_COMMIT_TEMPLATE;
	defaultBranchTemplate = SHORT_DEFAULT_BRANCH_TEMPLATE;
	defaultPRTemplate = SHORT_DEFAULT_PR_TEMPLATE;

	constructor(private response = "lorem ipsum") {}

	async evaluate(_prompt: Prompt): Promise<string> {
		return this.response;
	}
}

const diff1 = `
@@ -52,7 +52,8 @@

 export enum AnthropicModelName {
 	Opus = 'claude-3-opus-20240229',
-	Sonnet = 'claude-3-sonnet-20240229'
+	Sonnet = 'claude-3-sonnet-20240229',
+	Haiku = 'claude-3-haiku-20240307'
 }

 export const AI_SERVICE_CONTEXT = Symbol();
`;

const diff2 = `
@@ -52,7 +52,8 @@
 }
 async function commit() {
 	console.log('quack quack goes the dog');
+	const message = concatMessage(title, description);
 	isCommitting = true;
 try {
`;

const hunk1 = {
	diff: diff1,
	filePath: "foo/bar/baz.ts",
};
const hunk2 = {
	diff: diff2,
	filePath: "random.ts",
};

const exampleDiffs: DiffInput[] = [hunk1, hunk2];

const commitAuditMaterial: CommitAuditMaterial = {
	commits: [
		{
			id: "abc123",
			message: "fix parser boundary",
			metadata: { author: "Ada", committedAt: "2026-08-19T00:00:00Z" },
			files: [
				{
					path: "src/parser.ts",
					patch: "@@ -1,1 +1,2 @@",
					hunks: [
						{
							id: "abc123:src/parser.ts:0",
							header: "@@ -1,1 +1,2 @@",
							patch: "+guard",
						},
					],
				},
			],
		},
	],
	missingMaterials: [],
};

const commitAuditEvidence = {
	kind: "hunk" as const,
	commitId: "abc123",
	path: "src/parser.ts",
	hunk: "abc123:src/parser.ts:0",
};

function commitAuditReport() {
	return {
		commits: [
			{
				commitHash: "abc123",
				metadata: {
					author: "Ada",
					committedAt: "2026-08-19T00:00:00Z",
					message: "fix parser boundary",
				},
				changeCategories: ["bug修复"],
				objectiveChanges: [
					{
						text: "解析器新增了边界保护。",
						evidence: [commitAuditEvidence],
					},
				],
				motivation: INSUFFICIENT_MOTIVATION,
				tradeoffs: INSUFFICIENT_TRADEOFFS,
				risks: [],
				relatedClues: [],
				adversarialReview: {
					hiddenAssumptions: {
						isInference: true,
						text: "(推测)守卫依赖所有无效边界均会进入该分支。",
					},
					temporarySolution: {
						isInference: true,
						text: "(推测)材料不足以确认该守卫是否为临时过渡方案。",
					},
				},
				squashWarning: { isInference: true, text: "(推测)材料不足以判断是否应 squash。" },
			},
		],
	};
}

function buildDefaultServices() {
	const gitConfig = new DummyGitConfigService(structuredClone(defaultGitConfig));
	const secretsService = new DummySecretsService(structuredClone(defaultSecretsConfig));
	const tokenMemoryService = new TokenMemoryService();
	const fetchMock = vi.fn();
	const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
	return {
		tokenMemoryService,
		aiService: new AIService(gitConfig, secretsService, cloud, tokenMemoryService, dummyBackend),
	};
}

describe("AIService", () => {
	describe("#buildModel", () => {
		test("With default configuration, When a user token is provided. It returns ButlerAIClient", async () => {
			const { aiService, tokenMemoryService } = buildDefaultServices();
			tokenMemoryService.setToken("test-token");

			expect(await aiService.buildClient()).toBeInstanceOf(ButlerAIClient);
			tokenMemoryService.setToken(undefined);
		});

		test("With default configuration, When a user is undefined. It returns undefined", async () => {
			const { aiService, tokenMemoryService } = buildDefaultServices();

			await expect(aiService.buildClient.bind(aiService)).rejects.toThrowError(
				new Error("When using GitButler's API to summarize code, you must be logged in"),
			);
			tokenMemoryService.setToken(undefined);
		});

		test("When OpenAI uses a bring-your-own key, it returns BackendAiClient", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.OpenAIKeyOption]: KeyOption.BringYourOwn,
			});
			const secretsService = new DummySecretsService({ [AISecretHandle.OpenAIKey]: "sk-asdfasdf" });
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.buildClient()).toBeInstanceOf(BackendAiClient);
		});

		test("When OpenAI uses a bring-your-own key, it does not read the key in the renderer", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.OpenAIKeyOption]: KeyOption.BringYourOwn,
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);
			const getSecret = vi.spyOn(secretsService, "get");

			expect(await aiService.buildClient()).toBeInstanceOf(BackendAiClient);
			expect(getSecret).not.toHaveBeenCalledWith(AISecretHandle.OpenAIKey);
		});

		test("When ai provider is Anthropic, When token is bring your own, When an anthropic token is present. It returns AnthropicAIClient", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.ModelProvider]: ModelKind.Anthropic,
				[GitAIConfigKey.AnthropicKeyOption]: KeyOption.BringYourOwn,
			});
			const secretsService = new DummySecretsService({
				[AISecretHandle.AnthropicKey]: "test-key",
			});
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.buildClient()).toBeInstanceOf(AnthropicAIClient);
		});

		test("When ai provider is Anthropic, When token is bring your own, When an anthropic token is blank. It returns undefined", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.ModelProvider]: ModelKind.Anthropic,
				[GitAIConfigKey.AnthropicKeyOption]: KeyOption.BringYourOwn,
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			await expect(aiService.buildClient.bind(aiService)).rejects.toThrowError(
				new Error(
					"When using Anthropic in a bring your own key configuration, you must provide a valid token",
				),
			);
		});

		test("When ai provider is OpenRouter, When an API key is present. It returns OpenAIClient", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.ModelProvider]: ModelKind.OpenRouter,
			});
			const secretsService = new DummySecretsService({
				[AISecretHandle.OpenRouterKey]: "sk-or-test-key",
			});
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.buildClient()).toBeInstanceOf(OpenAIClient);
		});

		test("When ai provider is OpenRouter, When an API key is blank. It throws an error", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.ModelProvider]: ModelKind.OpenRouter,
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			await expect(aiService.buildClient.bind(aiService)).rejects.toThrowError(
				new Error("When using OpenRouter, you must provide a valid API key"),
			);
		});
	});

	describe("#getOpenAIModelName", () => {
		test("When a valid model is stored, it returns the stored value", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.OpenAIModelName]: OpenAIModelName.GPT54,
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.getOpenAIModelName()).toBe(OpenAIModelName.GPT54);
		});

		test("When a legacy/unknown model is stored, it falls back to the default", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.OpenAIModelName]: "relay-model",
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.getOpenAIModelName()).toBe("relay-model");
		});
	});

	describe("#getAnthropicModelName", () => {
		test("When a valid model is stored, it returns the stored value", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.AnthropicModelName]: AnthropicModelName.Opus,
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.getAnthropicModelName()).toBe(AnthropicModelName.Opus);
		});

		test("When a legacy/unknown model is stored, it falls back to the default", async () => {
			const gitConfig = new DummyGitConfigService({
				...defaultGitConfig,
				[GitAIConfigKey.AnthropicModelName]: "claude-3-opus-20240229",
			});
			const secretsService = new DummySecretsService();
			const tokenMemoryService = new TokenMemoryService();
			const fetchMock = vi.fn();
			const cloud = new HttpClient(fetchMock, "https://www.example.com", tokenMemoryService.token);
			const aiService = new AIService(
				gitConfig,
				secretsService,
				cloud,
				tokenMemoryService,
				dummyBackend,
			);

			expect(await aiService.getAnthropicModelName()).toBe(AnthropicModelName.Haiku);
		});
	});

	describe("#analyzeCommitAudit", () => {
		test("parses a valid structured commit audit report", async () => {
			const { aiService } = buildDefaultServices();
			const report = commitAuditReport();
			const client = new DummyAIClient();
			const evaluate = vi.spyOn(client, "evaluate").mockResolvedValue(JSON.stringify(report));
			const onToken = vi.fn();

			vi.spyOn(aiService, "buildClient").mockResolvedValue(client);

			expect(
				await aiService.analyzeCommitAudit({ material: commitAuditMaterial, onToken }),
			).toEqual(report);
			expect(evaluate).toHaveBeenCalledWith(
				[{ role: MessageRole.User, content: expect.stringContaining("审计材料") }],
				{ onToken },
			);
		});

		test("retries a non-JSON response with a JSON-only correction", async () => {
			const { aiService } = buildDefaultServices();
			const report = commitAuditReport();
			const client = new DummyAIClient();
			const evaluate = vi
				.spyOn(client, "evaluate")
				.mockResolvedValueOnce("this is not JSON")
				.mockResolvedValueOnce(JSON.stringify(report));

			vi.spyOn(aiService, "buildClient").mockResolvedValue(client);

			expect(await aiService.analyzeCommitAudit({ material: commitAuditMaterial })).toEqual(report);
			expect(evaluate).toHaveBeenCalledTimes(2);
			const secondPrompt = evaluate.mock.calls[1]![0];
			expect(secondPrompt).toEqual([
				{ role: MessageRole.User, content: expect.stringContaining("审计材料") },
				{
					role: MessageRole.User,
					content: expect.stringContaining("Return exactly one JSON object only"),
				},
			]);
			expect(secondPrompt[1]!.content).not.toContain("this is not JSON");
		});

		test("throws CommitAuditValidationError after two invalid responses", async () => {
			const { aiService } = buildDefaultServices();
			const client = new DummyAIClient();
			const evaluate = vi.spyOn(client, "evaluate").mockResolvedValue("this is not JSON");

			vi.spyOn(aiService, "buildClient").mockResolvedValue(client);

			await expect(
				aiService.analyzeCommitAudit({ material: commitAuditMaterial }),
			).rejects.toBeInstanceOf(CommitAuditValidationError);
			expect(evaluate).toHaveBeenCalledTimes(2);
		});

		test("returns undefined when no AI client is available", async () => {
			const { aiService } = buildDefaultServices();
			vi.spyOn(aiService, "buildClient").mockResolvedValue(undefined);

			expect(await aiService.analyzeCommitAudit({ material: commitAuditMaterial })).toBeUndefined();
		});
	});

	describe.concurrent("#summarizeCommit", async () => {
		test("When buildModel returns undefined, it returns undefined", async () => {
			const { aiService } = buildDefaultServices();

			vi.spyOn(aiService, "buildClient").mockReturnValue(Promise.resolve(undefined));

			expect(await aiService.summarizeCommit({ diffInput: exampleDiffs })).toStrictEqual(undefined);
		});

		test("When the AI returns a single line commit message, it returns it unchanged", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "single line commit";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(await aiService.summarizeCommit({ diffInput: exampleDiffs })).toStrictEqual(
				"single line commit",
			);
		});

		test("When the AI returns a title and body that is split by a single new line, it replaces it with two", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "one\nnew line";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(await aiService.summarizeCommit({ diffInput: exampleDiffs })).toStrictEqual(
				"one\n\nnew line",
			);
		});

		test("When the commit is in extra concise mode, When the AI returns a title and body, it takes just the title", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "one\nnew line";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(
				await aiService.summarizeCommit({ diffInput: exampleDiffs, useExtraConciseStyle: true }),
			).toStrictEqual("one");
		});
	});

	describe.concurrent("#summarizeBranch", async () => {
		test("When buildModel returns undefined, it returns undefined", async () => {
			const { aiService } = buildDefaultServices();

			vi.spyOn(aiService, "buildClient").mockReturnValue(Promise.resolve(undefined));

			expect(await aiService.summarizeBranch({ type: "hunks", hunks: exampleDiffs })).toStrictEqual(
				undefined,
			);
		});

		test("When the AI client returns a string with spaces, it replaces them with hypens", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "with spaces included";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(await aiService.summarizeBranch({ type: "hunks", hunks: exampleDiffs })).toStrictEqual(
				"with-spaces-included",
			);
		});

		test("When the AI client returns multiple lines, it replaces them with hypens", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "with\nnew\nlines\nincluded";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(await aiService.summarizeBranch({ type: "hunks", hunks: exampleDiffs })).toStrictEqual(
				"with-new-lines-included",
			);
		});

		test("When the AI client returns multiple lines and spaces, it replaces them with hypens", async () => {
			const { aiService } = buildDefaultServices();

			const clientResponse = "with\nnew lines\nincluded";

			vi.spyOn(aiService, "buildClient").mockReturnValue(
				Promise.resolve(new DummyAIClient(clientResponse)),
			);

			expect(await aiService.summarizeBranch({ type: "hunks", hunks: exampleDiffs })).toStrictEqual(
				"with-new-lines-included",
			);
		});
	});
});

describe.concurrent("buildDiff", () => {
	test("When provided one hunk, it returns the formatted diff", () => {
		const expectedOutput = `${hunk1.filePath} - ${hunk1.diff}`;

		expect(buildDiff([hunk1], 10000)).to.eq(expectedOutput);
	});

	test("When provided one hunk and its longer than the limit, it returns the truncated formatted diff", () => {
		expect(buildDiff([hunk1], 100).length).to.eq(100);
	});

	test("When provided multiple hunks, it joins them together with newlines", () => {
		const expectedOutput1 = `${hunk1.filePath} - ${hunk1.diff}\n${hunk2.filePath} - ${hunk2.diff}`;
		const expectedOutput2 = `${hunk2.filePath} - ${hunk2.diff}\n${hunk1.filePath} - ${hunk1.diff}`;

		const outputMatchesExpectedValue = [expectedOutput1, expectedOutput2].includes(
			buildDiff([hunk1, hunk2], 10000),
		);

		expect(outputMatchesExpectedValue).toBeTruthy();
	});
});
