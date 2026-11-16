use std::{collections::HashMap, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    multipart::{Form, Part},
    Client, Method, Proxy,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormDataValue {
    pub value: Option<String>,
    pub base64: Option<String>,
    pub file_name: Option<String>,
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestPayload {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body_text: Option<String>,
    pub body_base64: Option<String>,
    pub form: Option<HashMap<String, String>>,
    pub form_data: Option<HashMap<String, FormDataValue>>,
    pub timeout_ms: Option<u64>,
    pub proxy: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponsePayload {
    pub status_code: u16,
    pub status_message: String,
    pub headers: HashMap<String, String>,
    pub bytes: usize,
    pub body_text: String,
    pub raw_base64: String,
}

pub(crate) fn build_client(proxy: Option<&str>, timeout_ms: u64) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(1_000, 60_000)))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("OnePlayer/0.1 LX-Compatible");
    if let Some(proxy) = proxy.filter(|value| !value.trim().is_empty()) {
        builder = builder.proxy(Proxy::all(proxy).map_err(|error| error.to_string())?);
    }
    builder.build().map_err(|error| error.to_string())
}

fn build_headers(values: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    for (name, value) in values.unwrap_or_default() {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|error| error.to_string())?;
        let value = HeaderValue::from_str(&value).map_err(|error| error.to_string())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

#[tauri::command]
pub async fn proxy_http_request(
    payload: HttpRequestPayload,
) -> Result<HttpResponsePayload, String> {
    if !payload.url.starts_with("http://") && !payload.url.starts_with("https://") {
        return Err("仅支持 HTTP 与 HTTPS 请求".to_string());
    }
    let client = build_client(
        payload.proxy.as_deref(),
        payload.timeout_ms.unwrap_or(60_000),
    )?;
    let method = payload
        .method
        .as_deref()
        .unwrap_or("GET")
        .to_uppercase()
        .parse::<Method>()
        .map_err(|error| error.to_string())?;
    let mut request = client
        .request(method, &payload.url)
        .headers(build_headers(payload.headers)?);

    if let Some(form_data) = payload.form_data {
        let mut form = Form::new();
        for (name, value) in form_data {
            let mut part = if let Some(base64) = value.base64 {
                Part::bytes(
                    BASE64
                        .decode(base64)
                        .map_err(|error| format!("无效的 multipart Base64 数据：{error}"))?,
                )
            } else {
                Part::text(value.value.unwrap_or_default())
            };
            if let Some(file_name) = value.file_name {
                part = part.file_name(file_name);
            }
            if let Some(mime) = value.mime {
                part = part.mime_str(&mime).map_err(|error| error.to_string())?;
            }
            form = form.part(name, part);
        }
        request = request.multipart(form);
    } else if let Some(form) = payload.form {
        request = request.form(&form);
    } else if let Some(body_base64) = payload.body_base64 {
        request = request.body(
            BASE64
                .decode(body_base64)
                .map_err(|error| format!("无效的请求 Base64 数据：{error}"))?,
        );
    } else if let Some(body_text) = payload.body_text {
        request = request.body(body_text);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let status_message = status.canonical_reason().unwrap_or_default().to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    Ok(HttpResponsePayload {
        status_code: status.as_u16(),
        status_message,
        headers,
        bytes: bytes.len(),
        body_text: String::from_utf8_lossy(&bytes).into_owned(),
        raw_base64: BASE64.encode(&bytes),
    })
}
