// 翻译：桌面壳代发请求，避开浏览器 CORS；引擎、地址、Key、模型全部由前端配置传入。
// 只做「一段文本 → 一段译文」，不缓存、不落盘，缓存留给前端按句管理。
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrConfig {
    pub engine: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrRequest {
    pub config: TrConfig,
    pub texts: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct LlmRequest {
    pub config: TrConfig,
    pub system: String,
    pub user: String,
}

#[derive(Debug, Serialize)]
pub struct LlmModel {
    pub id: String,
    pub name: String,
}

fn llm_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(120))
        .user_agent("MyTranscript/0.1")
        .build()
        .map_err(|e| format!("网络客户端初始化失败：{e}"))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(45))
        .user_agent("MyTranscript/0.1")
        .build()
        .map_err(|e| format!("网络客户端初始化失败：{e}"))
}

fn non_empty(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("").trim()
}

fn target(cfg: &TrConfig) -> String {
    let t = non_empty(&cfg.target);
    if t.is_empty() { "zh-CN".to_string() } else { t.to_string() }
}

fn lang_name(target: &str) -> &'static str {
    match target {
        "zh-TW" => "Traditional Chinese",
        "en" => "English",
        "ja" => "Japanese",
        _ => "Simplified Chinese",
    }
}

fn snippet(body: &str) -> String {
    let cleaned: String = body.chars().take(160).collect();
    cleaned.replace('\n', " ")
}

pub async fn translate(req: TrRequest) -> Result<Vec<String>, String> {
    if req.texts.is_empty() {
        return Ok(Vec::new());
    }
    match req.config.engine.as_str() {
        "openai" => openai(&req).await,
        "deepl" => deepl(&req).await,
        "libre" => libre(&req).await,
        "microsoft" => microsoft(&req).await,
        "mymemory" => mymemory(&req).await,
        "google" => google(&req).await,
        other => Err(format!("未知翻译引擎：{other}")),
    }
}

/// 通用 AI 对话：按服务商分发到不同协议，统一返回文本。
/// OpenAI / DeepSeek / Kimi / GLM 走 Chat Completions；Claude 走 Messages；Gemini 走 generateContent。
pub async fn llm_chat(req: LlmRequest) -> Result<String, String> {
    let engine = req.config.engine.trim().to_ascii_lowercase();
    match engine.as_str() {
        "claude" | "anthropic" => claude_chat(&req).await,
        "gemini" | "google" => gemini_chat(&req).await,
        "openai" | "deepseek" | "kimi" | "glm" | "custom" | "openai-compatible" => openai_chat(&req).await,
        other => Err(format!("未知 AI 服务商：{other}")),
    }
}

fn llm_default_endpoint(engine: &str) -> &'static str {
    match engine {
        "deepseek" => "https://api.deepseek.com/v1",
        "kimi" => "https://api.moonshot.cn/v1",
        "glm" => "https://open.bigmodel.cn/api/paas/v4",
        "claude" | "anthropic" => "https://api.anthropic.com/v1/messages",
        "gemini" | "google" => "https://generativelanguage.googleapis.com/v1beta",
        _ => "https://api.openai.com/v1",
    }
}

fn chat_url(engine: &str, raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { llm_default_endpoint(engine) } else { raw };
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 AI 接口地址".into());
    }
    if base.ends_with("/chat/completions") {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}/chat/completions"))
    }
}

fn claude_url(raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { "https://api.anthropic.com/v1/messages" } else { raw };
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 Claude 接口地址".into());
    }
    if base.ends_with("/messages") {
        Ok(base.to_string())
    } else if base.ends_with("/v1") {
        Ok(format!("{base}/messages"))
    } else {
        Ok(format!("{base}/v1/messages"))
    }
}

fn gemini_url(model: &str, raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { "https://generativelanguage.googleapis.com/v1beta" } else { raw };
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 Gemini 接口地址".into());
    }
    if base.contains(":generateContent") {
        Ok(base.to_string())
    } else if base.contains("{model}") {
        Ok(base.replace("{model}", model))
    } else if base.contains("/models/") {
        Ok(format!("{base}:generateContent"))
    } else if base.ends_with("/models") {
        Ok(format!("{base}/{model}:generateContent"))
    } else {
        Ok(format!("{base}/models/{model}:generateContent"))
    }
}

fn models_url(engine: &str, raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { llm_default_endpoint(engine) } else { raw };
    let mut base = base.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写 AI 接口地址".into());
    }
    if base.ends_with("/chat/completions") {
        base.truncate(base.len() - "/chat/completions".len());
    }
    if base.ends_with("/models") {
        Ok(base)
    } else {
        Ok(format!("{base}/models"))
    }
}

fn claude_models_url(raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { "https://api.anthropic.com/v1/messages" } else { raw };
    let mut base = base.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写 Claude 接口地址".into());
    }
    if base.ends_with("/models") {
        return Ok(base);
    }
    if base.ends_with("/messages") {
        base.truncate(base.len() - "/messages".len());
        return Ok(format!("{base}/models"));
    }
    if base.ends_with("/v1") {
        Ok(format!("{base}/models"))
    } else {
        Ok(format!("{base}/v1/models"))
    }
}

fn gemini_models_url(raw: &str) -> Result<String, String> {
    let base = if raw.is_empty() { "https://generativelanguage.googleapis.com/v1beta" } else { raw };
    let mut base = base.trim_end_matches('/').to_string();
    if base.is_empty() {
        return Err("请先填写 Gemini 接口地址".into());
    }
    if let Some(pos) = base.find(":generateContent") {
        base.truncate(pos);
    }
    if let Some(pos) = base.find("/models/") {
        base.truncate(pos + "/models".len());
    }
    if base.ends_with("/models") {
        Ok(base)
    } else {
        Ok(format!("{base}/models"))
    }
}

fn parse_openai_models(parsed: &serde_json::Value, raw: &str) -> Result<Vec<LlmModel>, String> {
    let arr = parsed["data"]
        .as_array()
        .ok_or_else(|| format!("模型列表响应缺少 data 数组：{}", snippet(raw)))?;
    let mut out: Vec<LlmModel> = arr
        .iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?.trim();
            if id.is_empty() { return None; }
            let name = item["display_name"].as_str()
                .or_else(|| item["name"].as_str())
                .unwrap_or(id);
            Some(LlmModel { id: id.to_string(), name: name.to_string() })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    if out.is_empty() {
        return Err(format!("服务商没有返回可用模型：{}", snippet(raw)));
    }
    Ok(out)
}

fn parse_gemini_models(parsed: &serde_json::Value, raw: &str) -> Result<Vec<LlmModel>, String> {
    let arr = parsed["models"]
        .as_array()
        .ok_or_else(|| format!("模型列表响应缺少 models 数组：{}", snippet(raw)))?;
    let mut out: Vec<LlmModel> = arr
        .iter()
        .filter_map(|item| {
            let name = item["name"].as_str()?.trim();
            let id = name.strip_prefix("models/").unwrap_or(name);
            if id.is_empty() { return None; }
            if let Some(methods) = item["supportedGenerationMethods"].as_array() {
                if !methods.iter().any(|m| m.as_str() == Some("generateContent")) {
                    return None;
                }
            }
            let title = item["displayName"].as_str().unwrap_or(id);
            Some(LlmModel { id: id.to_string(), name: title.to_string() })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    if out.is_empty() {
        return Err(format!("Gemini 没有返回可用的 generateContent 模型：{}", snippet(raw)));
    }
    Ok(out)
}

/// 请求厂商模型目录。只返回 id + 展示名，不落盘；失败时保留前端手动输入。
pub async fn llm_models(config: TrConfig) -> Result<Vec<LlmModel>, String> {
    let engine = config.engine.trim().to_ascii_lowercase();
    let key = non_empty(&config.key);
    if key.is_empty() {
        return Err("获取模型列表需要 API Key".into());
    }
    let client = llm_client()?;
    let request = match engine.as_str() {
        "claude" | "anthropic" => {
            let url = claude_models_url(non_empty(&config.endpoint))?;
            client.get(url.as_str()).header("x-api-key", key).header("anthropic-version", "2023-06-01")
        }
        "gemini" | "google" => {
            let url = gemini_models_url(non_empty(&config.endpoint))?;
            client.get(url.as_str()).header("x-goog-api-key", key)
        }
        "openai" | "deepseek" | "kimi" | "glm" | "custom" | "openai-compatible" => {
            let url = models_url(&engine, non_empty(&config.endpoint))?;
            client.get(url.as_str()).bearer_auth(key)
        }
        other => return Err(format!("未知 AI 服务商：{other}")),
    };
    let res = request
        .send()
        .await
        .map_err(|e| format!("请求模型列表失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("模型列表返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("模型列表响应不是 JSON：{}", snippet(&text)))?;
    match engine.as_str() {
        "gemini" | "google" => parse_gemini_models(&parsed, &text),
        _ => parse_openai_models(&parsed, &text),
    }
}


fn openai_content(parsed: &serde_json::Value, raw: &str) -> Result<String, String> {
    if let Some(text) = parsed["choices"][0]["message"]["content"].as_str() {
        return Ok(text.to_string());
    }
    if let Some(parts) = parsed["choices"][0]["message"]["content"].as_array() {
        let joined: String = parts.iter().filter_map(|part| part["text"].as_str()).collect();
        if !joined.is_empty() {
            return Ok(joined);
        }
    }
    Err(format!("AI 服务响应缺少 choices[0].message.content：{}", snippet(raw)))
}

async fn openai_chat(req: &LlmRequest) -> Result<String, String> {
    let cfg = &req.config;
    let engine = cfg.engine.trim().to_ascii_lowercase();
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("AI 学英语需要 API Key".into());
    }
    let model = non_empty(&cfg.model);
    if model.is_empty() {
        return Err("AI 学英语需要模型名".into());
    }
    let url = chat_url(&engine, non_empty(&cfg.endpoint))?;
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": req.system},
            {"role": "user", "content": req.user}
        ]
    });
    let res = llm_client()?
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 AI 服务失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI 服务返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("AI 服务响应不是 JSON：{}", snippet(&text)))?;
    openai_content(&parsed, &text)
}

async fn claude_chat(req: &LlmRequest) -> Result<String, String> {
    let cfg = &req.config;
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("Claude 需要 API Key".into());
    }
    let model = non_empty(&cfg.model);
    if model.is_empty() {
        return Err("Claude 需要模型名".into());
    }
    let url = claude_url(non_empty(&cfg.endpoint))?;
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.3,
        "system": req.system,
        "messages": [
            {"role": "user", "content": req.user}
        ]
    });
    let res = llm_client()?
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 Claude 失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Claude 返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("Claude 响应不是 JSON：{}", snippet(&text)))?;
    let joined: String = parsed["content"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect())
        .unwrap_or_default();
    if joined.is_empty() {
        return Err(format!("Claude 响应缺少 content 文本：{}", snippet(&text)));
    }
    Ok(joined)
}

async fn gemini_chat(req: &LlmRequest) -> Result<String, String> {
    let cfg = &req.config;
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("Gemini 需要 API Key".into());
    }
    let model = non_empty(&cfg.model);
    if model.is_empty() {
        return Err("Gemini 需要模型名".into());
    }
    let url = gemini_url(model, non_empty(&cfg.endpoint))?;
    let body = serde_json::json!({
        "systemInstruction": {"parts": [{"text": req.system}]},
        "contents": [
            {"role": "user", "parts": [{"text": req.user}]}
        ],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 4096}
    });
    let res = llm_client()?
        .post(&url)
        .header("x-goog-api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 Gemini 失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Gemini 返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("Gemini 响应不是 JSON：{}", snippet(&text)))?;
    let joined: String = parsed["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect())
        .unwrap_or_default();
    if joined.is_empty() {
        let reason = parsed["promptFeedback"]["blockReason"].as_str().unwrap_or("");
        return Err(format!("Gemini 没有返回文本{}：{}", if reason.is_empty() { String::new() } else { format!("（{reason}）") }, snippet(&text)));
    }
    Ok(joined)
}

async fn openai(req: &TrRequest) -> Result<Vec<String>, String> {
    let cfg = &req.config;
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("OpenAI 兼容接口需要 API Key".into());
    }
    let model = non_empty(&cfg.model);
    if model.is_empty() {
        return Err("OpenAI 兼容接口需要模型名".into());
    }
    let base = non_empty(&cfg.endpoint);
    let base = if base.is_empty() { "https://api.openai.com/v1" } else { base };
    let base = base.trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };
    let target = target(cfg);
    let input = serde_json::to_string(&req.texts).map_err(|e| e.to_string())?;
    let system = format!(
        "You are a translation engine for podcast transcripts. Translate every string in the input JSON array into {} \
         (language code {}). Input is a JSON array of strings; output MUST be only a JSON array of translated strings \
         with exactly the same length and order. Do not add explanations, numbering, or code fences. Keep names, \
         numbers and technical terms accurate.",
        lang_name(&target),
        target
    );
    let body = serde_json::json!({
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": input}
        ]
    });
    let res = client()?
        .post(&url)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求翻译服务失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("翻译服务返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("翻译服务响应不是 JSON：{}", snippet(&text)))?;
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| format!("翻译服务响应缺少 choices[0].message.content：{}", snippet(&text)))?;
    let cleaned = content.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let start = cleaned.find('[').ok_or_else(|| "模型没有返回 JSON 数组".to_string())?;
    let end = cleaned.rfind(']').ok_or_else(|| "模型没有返回完整的 JSON 数组".to_string())?;
    let out: Vec<String> = serde_json::from_str(&cleaned[start..=end])
        .map_err(|e| format!("模型返回的 JSON 无法解析：{e}"))?;
    if out.len() != req.texts.len() {
        return Err(format!("译文条数不匹配：输入 {} 条，返回 {} 条", req.texts.len(), out.len()));
    }
    Ok(out)
}

async fn deepl(req: &TrRequest) -> Result<Vec<String>, String> {
    let cfg = &req.config;
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("DeepL 需要 API Key".into());
    }
    let audience = if key.ends_with(":fx") { "api-free.deepl.com" } else { "api.deepl.com" };
    let endpoint = non_empty(&cfg.endpoint);
    let base = if endpoint.is_empty() { format!("https://{audience}") } else { endpoint.trim_end_matches('/').to_string() };
    let url = if base.contains("/v2/translate") {
        base.clone()
    } else {
        format!("{base}/v2/translate")
    };
    let dl_target = match target(cfg).as_str() {
        "zh-TW" => "ZH-HANT",
        "en" => "EN-US",
        "ja" => "JA",
        _ => "ZH-HANS",
    };
    let mut form: Vec<(String, String)> = vec![("target_lang".into(), dl_target.into())];
    for t in &req.texts {
        form.push(("text".into(), t.clone()));
    }
    let res = client()?
        .post(&url)
        .header("Authorization", format!("DeepL-Auth-Key {key}"))
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("请求 DeepL 失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("DeepL 返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("DeepL 响应不是 JSON：{}", snippet(&text)))?;
    let arr = parsed["translations"]
        .as_array()
        .ok_or_else(|| "DeepL 响应缺少 translations".to_string())?;
    let out: Vec<String> = arr.iter().filter_map(|v| v["text"].as_str().map(str::to_string)).collect();
    if out.len() != req.texts.len() {
        return Err(format!("DeepL 译文条数不匹配：{} / {}", out.len(), req.texts.len()));
    }
    Ok(out)
}

async fn libre(req: &TrRequest) -> Result<Vec<String>, String> {
    let cfg = &req.config;
    let endpoint = non_empty(&cfg.endpoint);
    let base = if endpoint.is_empty() { "https://libretranslate.com" } else { endpoint };
    let base = base.trim_end_matches('/');
    let url = if base.ends_with("/translate") { base.to_string() } else { format!("{base}/translate") };
    let tl = match target(cfg).as_str() {
        "zh-TW" | "zh-CN" => "zh",
        "en" => "en",
        "ja" => "ja",
        _ => "zh",
    };
    let mut body = serde_json::json!({
        "q": req.texts,
        "source": "auto",
        "target": tl,
        "format": "text"
    });
    let key = non_empty(&cfg.key);
    if !key.is_empty() {
        body["api_key"] = serde_json::Value::String(key.to_string());
    }
    let res = client()?
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 LibreTranslate 失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("LibreTranslate 返回 HTTP {}：{}", status.as_u16(), snippet(&text)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| format!("LibreTranslate 响应不是 JSON：{}", snippet(&text)))?;
    let field = &parsed["translatedText"];
    let out: Vec<String> = if let Some(arr) = field.as_array() {
        arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
    } else if let Some(s) = field.as_str() {
        vec![s.to_string()]
    } else {
        return Err("LibreTranslate 响应缺少 translatedText".into());
    };
    if out.len() != req.texts.len() {
        return Err(format!("LibreTranslate 译文条数不匹配：{} / {}", out.len(), req.texts.len()));
    }
    Ok(out)
}

// MyMemory：免费、不需要 Key，国内可直连；按条翻译，源语言固定英文（播客原文都是英文）。
// 微软翻译（Azure AI Translator v3）：Key 必填，多区域资源的 Region 可填。
// 请求体是 [{"Text": "..."}] 数组，一条请求可以带多句。
async fn microsoft(req: &TrRequest) -> Result<Vec<String>, String> {
    let cfg = &req.config;
    let key = non_empty(&cfg.key);
    if key.is_empty() {
        return Err("微软翻译需要 Azure 订阅 Key".into());
    }
    let endpoint = non_empty(&cfg.endpoint);
    let base = if endpoint.is_empty() { "https://api.cognitive.microsofttranslator.com" } else { endpoint };
    let base = base.trim_end_matches('/');
    let url = if base.contains("/translate") { base.to_string() } else { format!("{base}/translate") };
    let to = match target(cfg).as_str() {
        "zh-TW" => "zh-Hant",
        "en" => "en",
        "ja" => "ja",
        _ => "zh-Hans",
    };
    let payload: Vec<serde_json::Value> = req
        .texts
        .iter()
        .map(|t| serde_json::json!({ "Text": t }))
        .collect();
    let mut builder = client()?
        .post(&url)
        .query(&[("api-version", "3.0"), ("to", to)])
        .header("Ocp-Apim-Subscription-Key", key)
        .json(&payload);
    let region = non_empty(&cfg.region);
    if !region.is_empty() {
        builder = builder.header("Ocp-Apim-Subscription-Region", region);
    }
    let res = builder.send().await.map_err(|e| format!("请求微软翻译失败：{e}"))?;
    let status = res.status();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("微软翻译返回 HTTP {}：{}", status.as_u16(), snippet(&body)));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| format!("微软翻译响应不是 JSON：{}", snippet(&body)))?;
    let arr = parsed.as_array().ok_or_else(|| "微软翻译响应不是数组".to_string())?;
    let mut out = Vec::with_capacity(req.texts.len());
    for item in arr {
        let text = item["translations"][0]["text"].as_str().unwrap_or("").to_string();
        if text.trim().is_empty() {
            return Err(format!("微软翻译没有返回译文：{}", snippet(&body)));
        }
        out.push(text);
        if out.len() == req.texts.len() {
            break;
        }
    }
    if out.len() != req.texts.len() {
        return Err(format!("微软翻译译文条数不匹配：{} / {}", out.len(), req.texts.len()));
    }
    Ok(out)
}

async fn mymemory(req: &TrRequest) -> Result<Vec<String>, String> {
    let tl = match target(&req.config).as_str() {
        "zh-TW" => "zh-TW",
        "ja" => "ja-JP",
        "en" => "en-US",
        _ => "zh-CN",
    };
    let langpair = format!("en|{tl}");
    let client = client()?;
    let mut out = Vec::with_capacity(req.texts.len());
    for text in &req.texts {
        let res = client
            .get("https://api.mymemory.translated.net/get")
            .query(&[("q", text.as_str()), ("langpair", langpair.as_str())])
            .send()
            .await
            .map_err(|e| format!("请求内置翻译失败：{e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("内置翻译返回 HTTP {}：{}", status.as_u16(), snippet(&body)));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| format!("内置翻译响应不是 JSON：{}", snippet(&body)))?;
        let translated = parsed["responseData"]["translatedText"].as_str().unwrap_or("").trim().to_string();
        if translated.is_empty() {
            let detail = parsed["responseDetails"].as_str().unwrap_or("");
            return Err(format!("内置翻译没有返回译文{}", if detail.is_empty() { String::new() } else { format!("：{detail}") }));
        }
        out.push(translated);
    }
    Ok(out)
}

async fn google(req: &TrRequest) -> Result<Vec<String>, String> {    let cfg = &req.config;
    let tl = match target(cfg).as_str() {
        "zh-TW" => "zh-TW",
        "en" => "en",
        "ja" => "ja",
        _ => "zh-CN",
    };
    let client = client()?;
    let mut out = Vec::with_capacity(req.texts.len());
    for text in &req.texts {
        let res = client
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[("client", "gtx"), ("sl", "auto"), ("tl", tl), ("dt", "t"), ("q", text.as_str())])
            .send()
            .await
            .map_err(|e| format!("请求内置翻译失败：{e}"))?;
        let status = res.status();
        let body = res.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("内置翻译返回 HTTP {}：{}", status.as_u16(), snippet(&body)));
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| format!("内置翻译响应不是 JSON：{}", snippet(&body)))?;
        let mut joined = String::new();
        if let Some(segs) = parsed[0].as_array() {
            for seg in segs {
                if let Some(s) = seg[0].as_str() {
                    joined.push_str(s);
                }
            }
        }
        if joined.trim().is_empty() {
            return Err("内置翻译没有返回译文".into());
        }
        out.push(joined);
    }
    Ok(out)
}
