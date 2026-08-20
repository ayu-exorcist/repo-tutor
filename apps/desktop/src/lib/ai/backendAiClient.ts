import {
	SHORT_DEFAULT_BRANCH_TEMPLATE,
	SHORT_DEFAULT_COMMIT_TEMPLATE,
	SHORT_DEFAULT_PR_TEMPLATE,
} from "$lib/ai/prompts";
import type { IBackend } from "$lib/backend/backend";
import { MessageRole, type AIClient, type AIEvalOptions, type Prompt } from "$lib/ai/types";

const DEFAULT_SYSTEM_MESSAGE =
	"You are a helpful AI assistant. Follow the user's instructions while protecting sensitive information.";

const AI_TOKEN_EVENT = "ai://response/token";
const AI_COMPLETED_EVENT = "ai://response/completed";
const AI_FAILED_EVENT = "ai://response/failed";

type TokenEvent = {
	requestId: string;
	token: string;
};

type CompletedEvent = {
	requestId: string;
	text: string;
};

type FailedEvent = {
	requestId: string;
	error: string;
};

export class BackendAiClient implements AIClient {
	defaultCommitTemplate = SHORT_DEFAULT_COMMIT_TEMPLATE;
	defaultBranchTemplate = SHORT_DEFAULT_BRANCH_TEMPLATE;
	defaultPRTemplate = SHORT_DEFAULT_PR_TEMPLATE;

	constructor(private backend: IBackend) {}

	async evaluate(prompt: Prompt, options?: AIEvalOptions): Promise<string> {
		const systemMessages = prompt
			.filter((message) => message.role === MessageRole.System)
			.map((message) => message.content);
		const messages = prompt.filter(
			(message) => message.role === MessageRole.User || message.role === MessageRole.Assistant,
		);

		if (messages.length === 0) {
			throw new Error("Prompt must contain at least one user or assistant message.");
		}

		const requestId = crypto.randomUUID();
		const request = {
			requestId,
			systemMessage: systemMessages.length > 0 ? systemMessages.join("\n") : DEFAULT_SYSTEM_MESSAGE,
			messages,
			maxTokens: options?.maxTokens,
		};
		const unlisteners: Array<() => Promise<void>> = [];

		try {
			return await new Promise<string>((resolve, reject) => {
				let settled = false;
				const resolveOnce = (text: string) => {
					if (settled) return;
					settled = true;
					resolve(text);
				};
				const rejectOnce = (error: unknown) => {
					if (settled) return;
					settled = true;
					reject(error);
				};

				unlisteners.push(
					this.backend.listen<TokenEvent>(AI_TOKEN_EVENT, ({ payload }) => {
						if (!settled && payload.requestId === requestId) {
							options?.onToken?.(payload.token);
						}
					}),
				);
				unlisteners.push(
					this.backend.listen<CompletedEvent>(AI_COMPLETED_EVENT, ({ payload }) => {
						if (payload.requestId === requestId) {
							resolveOnce(payload.text);
						}
					}),
				);
				unlisteners.push(
					this.backend.listen<FailedEvent>(AI_FAILED_EVENT, ({ payload }) => {
						if (payload.requestId === requestId) {
							rejectOnce(new Error(payload.error));
						}
					}),
				);

				void this.backend
					.invoke<unknown>("stream_configured_ai_response", { request })
					.then((response) => {
						if (typeof response === "string") resolveOnce(response);
					}, rejectOnce);
			});
		} finally {
			await Promise.all(unlisteners.map((unlisten) => unlisten()));
		}
	}
}
