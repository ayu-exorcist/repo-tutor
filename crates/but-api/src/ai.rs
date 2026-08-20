//! Application-global AI configuration and provider helpers.

use anyhow::{Context as _, Result, bail};
use but_core::git_config::edit_config;
use but_llm::{
    AI_ANTHROPIC_SECRET_HANDLE, AI_OPENAI_SECRET_HANDLE, AI_OPENROUTER_SECRET_HANDLE,
    AiConfiguration as DomainConfiguration, AnthropicConfiguration, CredentialsKeyOption,
    GITBUTLER_ACCESS_TOKEN_HANDLE, LLMProviderKind, LmStudioConfiguration, OllamaConfiguration,
    OpenAiConfiguration, clear_ai_configuration,
};
use but_secret::{Sensitive, secret};
use serde::{Deserialize, Serialize};

/// The non-sensitive application-global AI configuration.
///
/// API keys are represented only by the `*_has_api_key` flags. Stored key values
/// are never part of this response type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfiguration {
    /// The active provider.
    pub provider: String,
    /// The OpenAI credential source.
    pub openai_key_option: String,
    /// The OpenAI model.
    pub openai_model: String,
    /// An optional custom OpenAI-compatible endpoint.
    pub openai_custom_endpoint: Option<String>,
    /// Whether an OpenAI key is stored.
    pub openai_has_api_key: bool,
    /// The Anthropic credential source.
    pub anthropic_key_option: String,
    /// The Anthropic model.
    pub anthropic_model: String,
    /// Whether an Anthropic key is stored.
    pub anthropic_has_api_key: bool,
    /// The Ollama endpoint.
    pub ollama_endpoint: String,
    /// The Ollama model.
    pub ollama_model: String,
    /// The LM Studio endpoint.
    pub lmstudio_endpoint: String,
    /// The LM Studio model.
    pub lmstudio_model: String,
    /// Whether the active provider has valid settings and credentials.
    pub is_configured: bool,
}

/// A complete application-global AI configuration update.
///
/// API key fields are accepted on input but are deliberately omitted when this
/// value is serialized. `None` means keep the stored key unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigurationUpdate {
    /// The active provider.
    pub provider: String,
    /// The OpenAI credential source.
    pub openai_key_option: String,
    /// The OpenAI model.
    pub openai_model: String,
    /// An optional custom OpenAI-compatible endpoint.
    pub openai_custom_endpoint: Option<String>,
    /// A replacement OpenAI key. This is write-only.
    #[serde(skip_serializing)]
    pub openai_api_key: Option<String>,
    /// The Anthropic credential source.
    pub anthropic_key_option: String,
    /// The Anthropic model.
    pub anthropic_model: String,
    /// A replacement Anthropic key. This is write-only.
    #[serde(skip_serializing)]
    pub anthropic_api_key: Option<String>,
    /// The Ollama endpoint.
    pub ollama_endpoint: String,
    /// The Ollama model.
    pub ollama_model: String,
    /// The LM Studio endpoint.
    pub lmstudio_endpoint: String,
    /// The LM Studio model.
    pub lmstudio_model: String,
}

fn has_secret(handle: &str, namespace: secret::Namespace) -> Result<bool> {
    Ok(secret::retrieve(handle, namespace)?.is_some())
}

/// Read application-global AI configuration without exposing stored secrets.
pub fn get_ai_configuration() -> Result<AiConfiguration> {
    let config = gix::config::File::from_globals()?;
    let configuration = DomainConfiguration::from_git_config(&config)?;

    let openai_has_api_key = has_secret(AI_OPENAI_SECRET_HANDLE, secret::Namespace::Global)?;
    let anthropic_has_api_key = has_secret(AI_ANTHROPIC_SECRET_HANDLE, secret::Namespace::Global)?;
    let has_gitbutler_token =
        has_secret(GITBUTLER_ACCESS_TOKEN_HANDLE, secret::Namespace::BuildKind)?;
    let is_configured = configuration.is_configured(
        openai_has_api_key,
        anthropic_has_api_key,
        has_gitbutler_token,
    );

    Ok(AiConfiguration {
        provider: configuration.provider.as_git_config_value().into(),
        openai_key_option: configuration.openai.key_option.as_git_config_value().into(),
        openai_model: configuration.openai.model,
        openai_custom_endpoint: configuration.openai.custom_endpoint,
        openai_has_api_key,
        anthropic_key_option: configuration
            .anthropic
            .key_option
            .as_git_config_value()
            .into(),
        anthropic_model: configuration.anthropic.model,
        anthropic_has_api_key,
        ollama_endpoint: configuration.ollama.endpoint,
        ollama_model: configuration.ollama.model,
        lmstudio_endpoint: configuration.lmstudio.endpoint,
        lmstudio_model: configuration.lmstudio.model,
        is_configured,
    })
}

fn provider(value: &str) -> Result<LLMProviderKind> {
    match LLMProviderKind::from_git_config_value(value) {
        Some(
            provider @ (LLMProviderKind::OpenAi
            | LLMProviderKind::Anthropic
            | LLMProviderKind::Ollama
            | LLMProviderKind::LMStudio),
        ) => Ok(provider),
        _ => bail!("Unsupported AI provider '{value}'"),
    }
}

fn key_option(provider: &str, value: &str) -> Result<CredentialsKeyOption> {
    CredentialsKeyOption::from_git_config_value(value)
        .with_context(|| format!("Unsupported {provider} credential source '{value}'"))
}

fn submitted_key(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn domain_configuration(
    update: &AiConfigurationUpdate,
    mut configuration: DomainConfiguration,
) -> Result<DomainConfiguration> {
    configuration.provider = provider(&update.provider)?;
    configuration.openai = OpenAiConfiguration {
        key_option: key_option("OpenAI", &update.openai_key_option)?,
        model: update.openai_model.clone(),
        custom_endpoint: update.openai_custom_endpoint.clone(),
    };
    configuration.anthropic = AnthropicConfiguration {
        key_option: key_option("Anthropic", &update.anthropic_key_option)?,
        model: update.anthropic_model.clone(),
    };
    configuration.ollama = OllamaConfiguration {
        endpoint: update.ollama_endpoint.clone(),
        model: update.ollama_model.clone(),
    };
    configuration.lmstudio = LmStudioConfiguration {
        endpoint: update.lmstudio_endpoint.clone(),
        model: update.lmstudio_model.clone(),
    };
    configuration.validate_active()?;
    Ok(configuration)
}

fn validate_update(
    update: &AiConfigurationUpdate,
    openai_has_key: bool,
    anthropic_has_key: bool,
) -> Result<DomainConfiguration> {
    let configuration = domain_configuration(update, DomainConfiguration::default())?;

    if configuration.provider == LLMProviderKind::OpenAi
        && configuration.openai.key_option == CredentialsKeyOption::BringYourOwn
        && submitted_key(update.openai_api_key.clone()).is_none()
        && !openai_has_key
    {
        bail!("Enter an OpenAI API key")
    }
    if configuration.provider == LLMProviderKind::Anthropic
        && configuration.anthropic.key_option == CredentialsKeyOption::BringYourOwn
        && submitted_key(update.anthropic_api_key.clone()).is_none()
        && !anthropic_has_key
    {
        bail!("Enter an Anthropic API key")
    }
    Ok(configuration)
}

/// Validate and save one complete application-global AI configuration.
pub fn update_ai_configuration(update: AiConfigurationUpdate) -> Result<AiConfiguration> {
    let openai_has_key = has_secret(AI_OPENAI_SECRET_HANDLE, secret::Namespace::Global)?;
    let anthropic_has_key = has_secret(AI_ANTHROPIC_SECRET_HANDLE, secret::Namespace::Global)?;
    let configuration = validate_update(&update, openai_has_key, anthropic_has_key)?;

    if let Some(value) = submitted_key(update.openai_api_key) {
        secret::persist(
            AI_OPENAI_SECRET_HANDLE,
            &Sensitive(value),
            secret::Namespace::Global,
        )?;
    }
    if let Some(value) = submitted_key(update.anthropic_api_key) {
        secret::persist(
            AI_ANTHROPIC_SECRET_HANDLE,
            &Sensitive(value),
            secret::Namespace::Global,
        )?;
    }

    edit_config(None, gix::config::Source::User, |config| {
        configuration.apply(config)
    })?;

    get_ai_configuration()
}

/// Explicitly remove the stored OpenAI key without changing other settings.
pub fn clear_openai_api_key() -> Result<()> {
    secret::delete(AI_OPENAI_SECRET_HANDLE, secret::Namespace::Global)
}

/// Clear application-global AI configuration and all stored provider API keys.
pub fn reset_ai_configuration() -> Result<AiConfiguration> {
    edit_config(None, gix::config::Source::User, clear_ai_configuration)?;
    for handle in [
        AI_OPENAI_SECRET_HANDLE,
        AI_ANTHROPIC_SECRET_HANDLE,
        AI_OPENROUTER_SECRET_HANDLE,
    ] {
        secret::delete(handle, secret::Namespace::Global)?;
    }
    get_ai_configuration()
}

#[cfg(test)]
mod tests {
    use super::*;
    use but_llm::{
        DEFAULT_ANTHROPIC_MODEL, DEFAULT_LMSTUDIO_ENDPOINT, DEFAULT_LMSTUDIO_MODEL,
        DEFAULT_OLLAMA_ENDPOINT, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_MODEL,
    };

    fn valid_update() -> AiConfigurationUpdate {
        AiConfigurationUpdate {
            provider: "openai".into(),
            openai_key_option: "butlerAPI".into(),
            openai_model: DEFAULT_OPENAI_MODEL.into(),
            openai_custom_endpoint: None,
            openai_api_key: None,
            anthropic_key_option: "butlerAPI".into(),
            anthropic_model: DEFAULT_ANTHROPIC_MODEL.into(),
            anthropic_api_key: None,
            ollama_endpoint: DEFAULT_OLLAMA_ENDPOINT.into(),
            ollama_model: DEFAULT_OLLAMA_MODEL.into(),
            lmstudio_endpoint: DEFAULT_LMSTUDIO_ENDPOINT.into(),
            lmstudio_model: DEFAULT_LMSTUDIO_MODEL.into(),
        }
    }

    #[test]
    fn update_keys_are_write_only() {
        let mut update = valid_update();
        update.openai_api_key = Some("do-not-serialize".into());
        update.anthropic_api_key = Some("also-do-not-serialize".into());
        let json = serde_json::to_string(&update).unwrap();
        assert!(
            !json.contains("do-not-serialize"),
            "API keys must never serialize"
        );
        assert!(
            !json.contains("openaiApiKey"),
            "API key fields are write-only"
        );
    }

    #[test]
    fn responses_expose_key_presence_without_values() {
        let response = AiConfiguration {
            provider: "openai".into(),
            openai_key_option: "bringYourOwn".into(),
            openai_model: "model".into(),
            openai_custom_endpoint: None,
            openai_has_api_key: true,
            anthropic_key_option: "butlerAPI".into(),
            anthropic_model: "model".into(),
            anthropic_has_api_key: false,
            ollama_endpoint: "localhost:11434".into(),
            ollama_model: "model".into(),
            lmstudio_endpoint: "http://localhost:1234/v1".into(),
            lmstudio_model: "model".into(),
            is_configured: true,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(
            json.contains("openaiHasApiKey"),
            "responses expose key presence"
        );
        assert!(
            json.contains("true"),
            "stored key presence is represented as true"
        );
        assert!(
            !json.contains("apiKey"),
            "responses never contain API key values"
        );
    }

    #[test]
    fn validation_errors_do_not_echo_submitted_key() {
        let mut update = valid_update();
        update.openai_key_option = "bringYourOwn".into();
        update.openai_api_key = Some("secret-key-value".into());
        update.openai_model.clear();
        let error = validate_update(&update, false, false)
            .unwrap_err()
            .to_string();
        assert!(
            !error.contains("secret-key-value"),
            "validation errors must not contain keys"
        );

        update.openai_model = "model".into();
        update.openai_api_key = Some("   ".into());
        let error = validate_update(&update, false, false)
            .unwrap_err()
            .to_string();
        assert_eq!(error, "Enter an OpenAI API key");
    }
}
