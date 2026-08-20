use std::fmt::Debug;

use anyhow::Result;
use but_tools::tool::Toolset;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;

use crate::ChatMessage;

/// Optional controls for a streaming text completion.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamResponseOptions {
    /// Maximum number of completion tokens, when supported by the provider.
    pub max_tokens: Option<u32>,
}

pub trait LLMClient: Debug + Clone {
    fn model(&self) -> Option<String>;

    fn tool_calling_loop_stream(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        tool_set: &mut impl Toolset,
        model: &str,
        on_token: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<(String, Vec<ChatMessage>)>;

    fn tool_calling_loop(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        tool_set: &mut impl Toolset,
        model: &str,
    ) -> Result<String>;

    fn stream_response(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        model: &str,
        on_token: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Option<String>>;

    /// Stream a response with optional provider-specific controls.
    ///
    /// The default preserves the legacy behavior for providers that do not
    /// expose these controls yet.
    fn stream_response_with_options(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        model: &str,
        _options: StreamResponseOptions,
        on_token: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Option<String>> {
        self.stream_response(system_message, chat_messages, model, on_token)
    }

    fn response(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        model: &str,
    ) -> Result<Option<String>>;

    fn structured_output<
        T: serde::Serialize + DeserializeOwned + JsonSchema + std::marker::Send + 'static,
    >(
        &self,
        system_message: &str,
        chat_messages: Vec<ChatMessage>,
        model: &str,
    ) -> Result<Option<T>>;
}
