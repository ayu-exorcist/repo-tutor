use but_api::ai::{AiConfiguration, AiConfigurationUpdate};
use but_llm::{ChatMessage, LLMProvider, StreamResponseOptions};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, WebviewWindow};

fn classify_provider_error(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("401") || error.contains("unauthorized") || error.contains("invalid api key")
    {
        "AI provider rejected the API key"
    } else if error.contains("model") {
        "AI provider rejected the model name"
    } else if error.contains("max_tokens")
        || error.contains("completion_tokens")
        || error.contains("unsupported parameter")
    {
        "AI provider rejected the token parameter"
    } else if error.contains("connect") || error.contains("timeout") || error.contains("dns") {
        "AI provider could not be reached"
    } else {
        "AI provider request failed"
    }
}

pub const AI_TOKEN_EVENT: &str = "ai://response/token";
pub const AI_COMPLETED_EVENT: &str = "ai://response/completed";
pub const AI_FAILED_EVENT: &str = "ai://response/failed";

const MAX_MESSAGES: usize = 128;
const MAX_MESSAGE_LENGTH: usize = 1_000_000;
const MAX_TOKENS: u32 = 128_000;

/// The transport request for a configured AI response.
///
/// Provider settings and credentials are intentionally not part of this DTO.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamConfiguredAiRequest {
    pub request_id: String,
    pub system_message: String,
    pub messages: Vec<AiMessage>,
    pub max_tokens: Option<u32>,
}

/// A user or assistant message accepted by the AI transport.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum AiMessage {
    User { content: String },
    Assistant { content: String },
}

impl From<AiMessage> for ChatMessage {
    fn from(message: AiMessage) -> Self {
        match message {
            AiMessage::User { content } => Self::User(content),
            AiMessage::Assistant { content } => Self::Assistant(content),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent {
    request_id: String,
    token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedEvent {
    request_id: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedEvent {
    request_id: String,
    error: String,
}

#[tauri::command(async)]
pub fn get_ai_configuration() -> Result<AiConfiguration, String> {
    but_api::ai::get_ai_configuration().map_err(|_| "Failed to read AI configuration".to_string())
}

#[tauri::command(async)]
pub fn update_ai_configuration(update: AiConfigurationUpdate) -> Result<AiConfiguration, String> {
    but_api::ai::update_ai_configuration(update)
        .map_err(|_| "Failed to update AI configuration".to_string())
}

#[tauri::command(async)]
pub fn clear_openai_api_key() -> Result<(), String> {
    but_api::ai::clear_openai_api_key()
        .map_err(|_| "Failed to clear the OpenAI API key".to_string())
}

#[tauri::command(async)]
pub async fn stream_configured_ai_response(
    window: WebviewWindow,
    request: StreamConfiguredAiRequest,
) -> Result<String, String> {
    if validate_request(&request).is_err() {
        return fail(&window, &request.request_id, "AI request failed");
    }

    let window_for_stream = window.clone();
    tauri::async_runtime::spawn_blocking(move || stream_response(window_for_stream, request))
        .await
        .map_err(|_| "AI request failed".to_string())?
}

fn validate_request(request: &StreamConfiguredAiRequest) -> Result<(), String> {
    if request.request_id.trim().is_empty() {
        return Err("AI request failed".to_string());
    }
    if request.system_message.trim().is_empty()
        || request.messages.is_empty()
        || request.messages.len() > MAX_MESSAGES
    {
        return Err("AI request failed".to_string());
    }
    if request.system_message.len() > MAX_MESSAGE_LENGTH
        || request.messages.iter().any(|message| match message {
            AiMessage::User { content } | AiMessage::Assistant { content } => {
                content.trim().is_empty() || content.len() > MAX_MESSAGE_LENGTH
            }
        })
    {
        return Err("AI request failed".to_string());
    }
    if request
        .max_tokens
        .is_some_and(|tokens| tokens == 0 || tokens > MAX_TOKENS)
    {
        return Err("AI request failed".to_string());
    }
    Ok(())
}

fn stream_response(
    window: WebviewWindow,
    request: StreamConfiguredAiRequest,
) -> Result<String, String> {
    let request_id = request.request_id.clone();
    let configuration = match but_api::ai::get_ai_configuration() {
        Ok(configuration) => configuration,
        Err(_) => return fail(&window, &request_id, "AI request failed"),
    };
    let global_config = match gix::config::File::from_globals() {
        Ok(config) => config,
        Err(_) => return fail(&window, &request_id, "AI request failed"),
    };
    let provider = match LLMProvider::from_git_config(&global_config) {
        Some(provider) => provider,
        None => return fail(&window, &request_id, "AI request failed"),
    };
    let model = match configuration.provider.as_str() {
        "openai" => configuration.openai_model,
        "anthropic" => configuration.anthropic_model,
        "ollama" => configuration.ollama_model,
        "lmstudio" => configuration.lmstudio_model,
        _ => return fail(&window, &request_id, "AI request failed"),
    };
    let request_id_for_tokens = request_id.clone();
    let window_for_tokens = window.clone();
    let result = provider.stream_response_with_options(
        &request.system_message,
        request.messages.into_iter().map(Into::into).collect(),
        &model,
        StreamResponseOptions {
            max_tokens: request.max_tokens,
        },
        move |token| {
            let _ = window_for_tokens.emit(
                AI_TOKEN_EVENT,
                TokenEvent {
                    request_id: request_id_for_tokens.clone(),
                    token: token.to_string(),
                },
            );
        },
    );

    match result {
        Ok(Some(text)) => {
            if window
                .emit(
                    AI_COMPLETED_EVENT,
                    CompletedEvent {
                        request_id: request_id.clone(),
                        text: text.clone(),
                    },
                )
                .is_err()
            {
                return fail(&window, &request_id, "AI request failed");
            }
            Ok(text)
        }
        Ok(None) => fail(&window, &request_id, "AI request failed"),
        Err(error) => fail(
            &window,
            &request_id,
            classify_provider_error(&error.to_string()),
        ),
    }
}

fn fail(window: &WebviewWindow, request_id: &str, error: &str) -> Result<String, String> {
    let error = error.to_string();
    let _ = window.emit(
        AI_FAILED_EVENT,
        FailedEvent {
            request_id: request_id.to_string(),
            error: error.clone(),
        },
    );
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_request_contains_only_transport_fields() {
        let request: StreamConfiguredAiRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request-1",
            "systemMessage": "system",
            "messages": [{"role": "user", "content": "hello"}],
            "maxTokens": 42
        }))
        .unwrap();

        assert_eq!(request.request_id, "request-1");
        assert_eq!(request.max_tokens, Some(42));
        assert!(matches!(request.messages[0], AiMessage::User { .. }));

        let extra_field = serde_json::from_value::<StreamConfiguredAiRequest>(serde_json::json!({
            "requestId": "request-1",
            "systemMessage": "system",
            "messages": [{"role": "user", "content": "hello"}],
            "model": "must-not-be-accepted-as-a-field"
        }));
        assert!(
            extra_field.is_err(),
            "transport DTO must reject provider fields"
        );
    }

    #[test]
    fn stream_request_rejects_system_messages() {
        let result = serde_json::from_value::<StreamConfiguredAiRequest>(serde_json::json!({
            "requestId": "request-1",
            "systemMessage": "system",
            "messages": [{"role": "system", "content": "not allowed"}]
        }));

        assert!(
            result.is_err(),
            "transport accepts only user/assistant messages"
        );
    }

    #[test]
    fn event_names_are_stable_and_scoped_to_ai_response() {
        assert_eq!(AI_TOKEN_EVENT, "ai://response/token");
        assert_eq!(AI_COMPLETED_EVENT, "ai://response/completed");
        assert_eq!(AI_FAILED_EVENT, "ai://response/failed");
    }

    #[test]
    fn classifies_provider_errors_without_disclosing_the_original_error() {
        let cases = [
            (
                "401 unauthorized: invalid api key sk-test https://api.example.test",
                "AI provider rejected the API key",
            ),
            (
                "model `secret-model` does not exist; Authorization: Bearer sk-test",
                "AI provider rejected the model name",
            ),
            (
                "unsupported parameter max_tokens in request body completion_tokens=42",
                "AI provider rejected the token parameter",
            ),
            (
                "connect timeout resolving dns api.example.test with body secret",
                "AI provider could not be reached",
            ),
            (
                "unexpected upstream response with x-api-key: sk-test",
                "AI provider request failed",
            ),
        ];

        for (input, expected) in cases {
            let classified = classify_provider_error(input);
            assert_eq!(classified, expected);
            assert!(!classified.contains(input));
            assert!(!classified.contains("sk-test"));
            assert!(!classified.contains("api.example.test"));
        }
    }
}
