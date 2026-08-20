use std::sync::Arc;

use but_llm::{ChatMessage, LLMProvider, StreamResponseOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};

use crate::broadcaster::{Broadcaster, FrontendEvent};

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

pub(crate) const AI_TOKEN_EVENT: &str = "ai://response/token";
pub(crate) const AI_COMPLETED_EVENT: &str = "ai://response/completed";
pub(crate) const AI_FAILED_EVENT: &str = "ai://response/failed";

const MAX_MESSAGES: usize = 128;
const MAX_MESSAGE_LENGTH: usize = 1_000_000;
const MAX_TOKENS: u32 = 128_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StreamRequest {
    pub request_id: String,
    pub system_message: String,
    pub messages: Vec<PromptMessage>,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StreamCommand {
    pub request: StreamRequest,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateCommand {
    pub update: but_api::ai::AiConfigurationUpdate,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub(crate) enum PromptMessage {
    User { content: String },
    Assistant { content: String },
}

impl From<PromptMessage> for ChatMessage {
    fn from(message: PromptMessage) -> Self {
        match message {
            PromptMessage::User { content } => ChatMessage::User(content),
            PromptMessage::Assistant { content } => ChatMessage::Assistant(content),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent {
    request_id: String,
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedEvent {
    request_id: String,
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedEvent {
    request_id: String,
    error: String,
}

fn frontend_event<T: Serialize>(name: &str, payload: T) -> FrontendEvent {
    FrontendEvent {
        name: name.to_string(),
        payload: serde_json::to_value(payload).expect("AI event is serializable"),
    }
}

fn validate_request(request: &StreamRequest) -> anyhow::Result<()> {
    if request.request_id.trim().is_empty()
        || request.system_message.trim().is_empty()
        || request.messages.is_empty()
        || request.messages.len() > MAX_MESSAGES
    {
        anyhow::bail!("AI request failed")
    }
    if request.system_message.len() > MAX_MESSAGE_LENGTH
        || request.messages.iter().any(|message| match message {
            PromptMessage::User { content } | PromptMessage::Assistant { content } => {
                content.trim().is_empty() || content.len() > MAX_MESSAGE_LENGTH
            }
        })
    {
        anyhow::bail!("AI request failed")
    }
    if request
        .max_tokens
        .is_some_and(|tokens| tokens == 0 || tokens > MAX_TOKENS)
    {
        anyhow::bail!("AI request failed")
    }
    Ok(())
}

pub(crate) fn start_stream(
    request: StreamRequest,
    broadcaster: Arc<Mutex<Broadcaster>>,
) -> anyhow::Result<Value> {
    if validate_request(&request).is_err() {
        let request_id = request.request_id.clone();
        tokio::spawn(async move {
            broadcaster.lock().await.send(frontend_event(
                AI_FAILED_EVENT,
                FailedEvent {
                    request_id,
                    error: "AI request failed".to_string(),
                },
            ));
        });
        anyhow::bail!("AI request failed")
    }

    let request_id = request.request_id.clone();
    let (events, mut receive_events) = mpsc::unbounded_channel();
    let event_broadcaster = broadcaster;
    tokio::spawn(async move {
        while let Some(event) = receive_events.recv().await {
            event_broadcaster.lock().await.send(event);
        }
    });

    let messages = request
        .messages
        .into_iter()
        .map(ChatMessage::from)
        .collect::<Vec<_>>();
    let system_message = request.system_message;
    let max_tokens = request.max_tokens;
    let event_request_id = request_id.clone();
    tokio::task::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<Option<String>> {
            let configuration = but_api::ai::get_ai_configuration()
                .map_err(|_| anyhow::anyhow!("AI request failed"))?;
            let config = gix::config::File::from_globals()
                .map_err(|_| anyhow::anyhow!("AI request failed"))?;
            let provider = LLMProvider::from_git_config(&config)
                .ok_or_else(|| anyhow::anyhow!("AI request failed"))?;
            let model = match configuration.provider.as_str() {
                "openai" => configuration.openai_model,
                "anthropic" => configuration.anthropic_model,
                "ollama" => configuration.ollama_model,
                "lmstudio" => configuration.lmstudio_model,
                _ => anyhow::bail!("AI request failed"),
            };
            let token_events = events.clone();
            let token_request_id = event_request_id.clone();
            provider.stream_response_with_options(
                &system_message,
                messages,
                &model,
                StreamResponseOptions { max_tokens },
                move |token| {
                    let _ = token_events.send(frontend_event(
                        AI_TOKEN_EVENT,
                        TokenEvent {
                            request_id: token_request_id.clone(),
                            token: token.to_string(),
                        },
                    ));
                },
            )
        })();

        match result {
            Ok(Some(text)) => {
                let _ = events.send(frontend_event(
                    AI_COMPLETED_EVENT,
                    CompletedEvent {
                        request_id: event_request_id,
                        text,
                    },
                ));
            }
            Err(error) => {
                let _ = events.send(frontend_event(
                    AI_FAILED_EVENT,
                    FailedEvent {
                        request_id: event_request_id,
                        error: classify_provider_error(&error.to_string()).to_string(),
                    },
                ));
            }
            Ok(None) => {
                let _ = events.send(frontend_event(
                    AI_FAILED_EVENT,
                    FailedEvent {
                        request_id: event_request_id,
                        error: "AI request failed".to_string(),
                    },
                ));
            }
        }
    });

    Ok(json!({ "requestId": request_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_desktop_web_stream_request_shape() {
        let request: StreamRequest = serde_json::from_value(json!({
            "requestId": "request-1",
            "systemMessage": "You are concise.",
            "messages": [{ "role": "user", "content": "hello" }],
            "maxTokens": 42
        }))
        .unwrap();

        assert_eq!(request.request_id, "request-1");
        assert!(matches!(&request.messages[0], PromptMessage::User { .. }));
        assert_eq!(request.max_tokens, Some(42));
    }

    #[test]
    fn stream_request_rejects_provider_settings_and_system_messages() {
        let provider_field = serde_json::from_value::<StreamRequest>(json!({
            "requestId": "request-1",
            "systemMessage": "system",
            "messages": [{ "role": "user", "content": "hello" }],
            "model": "must-not-be-client-controlled"
        }));
        let system_message = serde_json::from_value::<StreamRequest>(json!({
            "requestId": "request-1",
            "systemMessage": "system",
            "messages": [{ "role": "system", "content": "not allowed" }]
        }));

        assert!(
            provider_field.is_err(),
            "provider settings must stay server-side"
        );
        assert!(
            system_message.is_err(),
            "transport accepts only user/assistant messages"
        );
    }

    #[test]
    fn event_payloads_match_the_tauri_ai_transport() {
        let token = frontend_event(
            AI_TOKEN_EVENT,
            TokenEvent {
                request_id: "request-1".into(),
                token: "hello".into(),
            },
        );
        let completed = frontend_event(
            AI_COMPLETED_EVENT,
            CompletedEvent {
                request_id: "request-1".into(),
                text: "hello".into(),
            },
        );
        let failed = frontend_event(
            AI_FAILED_EVENT,
            FailedEvent {
                request_id: "request-1".into(),
                error: "AI request failed".into(),
            },
        );

        assert_eq!(token.name, "ai://response/token");
        assert_eq!(token.payload["requestId"], "request-1");
        assert_eq!(token.payload["token"], "hello");
        assert_eq!(completed.name, "ai://response/completed");
        assert_eq!(completed.payload["text"], "hello");
        assert_eq!(failed.name, "ai://response/failed");
        assert_eq!(failed.payload["error"], "AI request failed");
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
