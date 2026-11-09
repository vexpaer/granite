use std::collections::BTreeMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{redirect::Policy, Method, Url};
use sha2::{Digest, Sha256};

use crate::error::{HostError, HostResult};
use crate::models::{ProviderProfile, ProviderResponse, ProviderType};

const MAX_PROVIDER_RESPONSE_BYTES: usize = 512 * 1024 * 1024;
const MAX_PROVIDER_REQUEST_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 20 * 1024 * 1024;
const AWS_URI_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');
const AWS_URI_PATH_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~')
    .remove(b'/');

pub async fn fetch_plugin_archive(source_url: &str, max_bytes: u64) -> HostResult<Vec<u8>> {
    if max_bytes == 0 || max_bytes > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(HostError::InvalidArgs(format!(
            "plugin fetch maxBytes must be from 1 through {MAX_PLUGIN_ARCHIVE_BYTES}"
        )));
    }
    let max_bytes = usize::try_from(max_bytes)
        .map_err(|_| HostError::Unsupported("plugin fetch size limit is too large".into()))?;
    let mut source = Url::parse(source_url)
        .map_err(|_| HostError::InvalidArgs("plugin URL is invalid".into()))?;
    validate_plugin_source_url(&source)?;
    source.set_fragment(None);

    let client = reqwest::Client::builder()
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 || validate_plugin_source_url(attempt.url()).is_err()
            {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| HostError::Network(format!("failed to build HTTP client: {error}")))?;
    let mut response = client
        .get(source)
        .send()
        .await
        .map_err(|error| HostError::Network(format!("plugin fetch failed: {error}")))?;
    if !response.status().is_success() {
        return Err(HostError::Network(format!(
            "plugin fetch returned HTTP {}",
            response.status().as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(HostError::Unsupported(format!(
            "plugin archive exceeds the {max_bytes}-byte requested limit"
        )));
    }

    let initial_capacity = response
        .content_length()
        .and_then(|length| usize::try_from(length).ok())
        .unwrap_or(0)
        .min(max_bytes);
    let mut bytes = Vec::with_capacity(initial_capacity);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| HostError::Network(format!("plugin fetch read failed: {error}")))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(HostError::Unsupported(format!(
                "plugin archive exceeds the {max_bytes}-byte requested limit"
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_plugin_source_url(url: &Url) -> HostResult<()> {
    if url.scheme() != "https" {
        return Err(HostError::Forbidden(
            "plugin sources and redirects must use HTTPS".into(),
        ));
    }
    if url.host_str().is_none() {
        return Err(HostError::InvalidArgs(
            "plugin source URL has no host".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::Forbidden(
            "plugin source URLs must not contain embedded credentials".into(),
        ));
    }
    Ok(())
}

pub async fn provider_request(
    profile: ProviderProfile,
    method: String,
    key: String,
    body: Option<Vec<u8>>,
    headers: BTreeMap<String, String>,
    secret: &str,
) -> HostResult<ProviderResponse> {
    if let Some(body) = body.as_ref() {
        if body.len() > MAX_PROVIDER_REQUEST_BYTES {
            return Err(HostError::Unsupported(format!(
                "provider request body exceeds the {MAX_PROVIDER_REQUEST_BYTES}-byte native bridge limit"
            )));
        }
    }
    let method = Method::from_bytes(method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| HostError::InvalidArgs("provider request method is invalid".into()))?;
    if matches!(method, Method::CONNECT | Method::TRACE) {
        return Err(HostError::InvalidArgs(
            "CONNECT and TRACE are not allowed for provider requests".into(),
        ));
    }
    validate_remote_key(&key)?;
    let url = build_provider_url(&profile, &key)?;
    let mut request_headers = sanitize_headers(headers)?;
    match profile.provider_type {
        ProviderType::Webdav => {
            let username = profile
                .username
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    HostError::InvalidArgs("WebDAV profile requires a username".into())
                })?;
            let encoded = BASE64.encode(format!("{username}:{secret}"));
            request_headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Basic {encoded}")).map_err(|_| {
                    HostError::InvalidArgs(
                        "WebDAV username produced an invalid authorization header".into(),
                    )
                })?,
            );
        }
        ProviderType::S3 => {
            let access_key = profile
                .access_key_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| HostError::InvalidArgs("S3 profile requires accessKeyId".into()))?;
            let region = profile
                .region
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| HostError::InvalidArgs("S3 profile requires region".into()))?;
            let authorization = sign_s3_request(
                &method,
                &url,
                &mut request_headers,
                body.as_deref().unwrap_or_default(),
                access_key,
                secret,
                region,
                Utc::now(),
            )?;
            request_headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&authorization).map_err(|_| {
                    HostError::Internal("generated S3 authorization header is invalid".into())
                })?,
            );
        }
    }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| HostError::Network(format!("failed to build HTTP client: {error}")))?;
    let mut request = client.request(method, url).headers(request_headers);
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| HostError::Network(format!("provider request failed: {error}")))?;
    let status = response.status().as_u16();
    let response_headers = combine_response_headers(response.headers())?;
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| HostError::Network(format!("provider response read failed: {error}")))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_PROVIDER_RESPONSE_BYTES {
            return Err(HostError::Unsupported(format!(
                "provider response exceeds the {MAX_PROVIDER_RESPONSE_BYTES}-byte native bridge limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(ProviderResponse {
        status,
        headers: response_headers,
        body,
    })
}

fn validate_remote_key(key: &str) -> HostResult<()> {
    if key.contains('\0') || key.chars().any(char::is_control) {
        return Err(HostError::InvalidArgs(
            "provider object key contains a control character".into(),
        ));
    }
    let path = key.split_once('?').map(|(path, _)| path).unwrap_or(key);
    if path.starts_with('/') {
        return Err(HostError::Forbidden(
            "provider object key must be relative to the configured prefix".into(),
        ));
    }
    for component in path.split('/') {
        if component == ".." {
            return Err(HostError::Forbidden(
                "provider object key cannot contain '..' components".into(),
            ));
        }
    }
    Ok(())
}

fn build_provider_url(profile: &ProviderProfile, key: &str) -> HostResult<Url> {
    validate_remote_key(key)?;
    let mut url = Url::parse(&profile.endpoint)
        .map_err(|_| HostError::InvalidArgs("provider endpoint is not a valid URL".into()))?;
    if url.scheme() != "https" {
        return Err(HostError::Forbidden(
            "provider endpoints must use TLS (https://)".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(HostError::Forbidden(
            "provider credentials must not be embedded in the endpoint URL".into(),
        ));
    }
    url.set_fragment(None);
    let (key_path, query) = key
        .split_once('?')
        .map(|(path, query)| (path, Some(query)))
        .unwrap_or((key, None));

    let mut path_parts = Vec::new();
    if profile.provider_type == ProviderType::S3 {
        let bucket = profile
            .bucket
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| HostError::InvalidArgs("S3 profile requires a bucket".into()))?;
        path_parts.extend(split_remote_path(bucket));
    }
    path_parts.extend(split_remote_path(&profile.prefix));
    path_parts.extend(split_remote_path(key_path));

    let base_ends_with_slash = url.path().ends_with('/');
    {
        let mut segments = url.path_segments_mut().map_err(|_| {
            HostError::InvalidArgs("provider endpoint cannot be used as a base URL".into())
        })?;
        if base_ends_with_slash {
            segments.pop_if_empty();
        }
        segments.extend(path_parts);
    }
    if let Some(query) = query {
        url.set_query(Some(query));
    }
    Ok(url)
}

fn split_remote_path(value: &str) -> impl Iterator<Item = &str> {
    value
        .split('/')
        .filter(|component| !component.is_empty() && *component != ".")
}

fn sanitize_headers(headers: BTreeMap<String, String>) -> HostResult<HeaderMap> {
    let mut result = HeaderMap::new();
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "authorization"
                | "host"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "proxy-authorization"
                | "proxy-connection"
                | "upgrade"
                | "x-amz-date"
                | "x-amz-content-sha256"
        ) {
            return Err(HostError::Forbidden(format!(
                "provider header '{name}' is managed by the native host"
            )));
        }
        if value.contains('\r') || value.contains('\n') || value.contains('\0') {
            return Err(HostError::InvalidArgs(format!(
                "provider header '{name}' contains an invalid control character"
            )));
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| HostError::InvalidArgs(format!("provider header '{name}' is invalid")))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| HostError::InvalidArgs(format!("provider header '{name}' is invalid")))?;
        result.append(header_name, header_value);
    }
    Ok(result)
}

fn combine_response_headers(headers: &HeaderMap) -> HostResult<BTreeMap<String, String>> {
    let mut combined: BTreeMap<String, String> = BTreeMap::new();
    for (name, value) in headers {
        let value = value.to_str().map_err(|_| {
            HostError::Network(format!(
                "provider response header '{}' is not valid visible ASCII",
                name.as_str()
            ))
        })?;
        combined
            .entry(name.as_str().to_owned())
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    Ok(combined)
}

fn sign_s3_request(
    method: &Method,
    url: &Url,
    headers: &mut HeaderMap,
    body: &[u8],
    access_key: &str,
    secret_key: &str,
    region: &str,
    now: DateTime<Utc>,
) -> HostResult<String> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let payload_hash = sha256_hex(body);
    headers.insert(
        HeaderName::from_static("x-amz-date"),
        HeaderValue::from_str(&amz_date)
            .map_err(|_| HostError::Internal("failed to create x-amz-date".into()))?,
    );
    headers.insert(
        HeaderName::from_static("x-amz-content-sha256"),
        HeaderValue::from_str(&payload_hash)
            .map_err(|_| HostError::Internal("failed to create x-amz-content-sha256".into()))?,
    );

    let mut canonical_headers = BTreeMap::new();
    canonical_headers.insert("host".to_owned(), canonical_host(url)?);
    for (name, value) in headers.iter() {
        let value = value
            .to_str()
            .map_err(|_| HostError::InvalidArgs("request header is not visible ASCII".into()))?;
        canonical_headers.insert(name.as_str().to_ascii_lowercase(), collapse_spaces(value));
    }
    let signed_headers = canonical_headers
        .keys()
        .cloned()
        .collect::<Vec<_>>()
        .join(";");
    let canonical_header_text = canonical_headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect::<String>();
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri(url),
        canonical_query(url),
        canonical_header_text,
        signed_headers,
        payload_hash
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    let date_key = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, b"s3")?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    Ok(format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    ))
}

fn canonical_host(url: &Url) -> HostResult<String> {
    let host = url
        .host_str()
        .ok_or_else(|| HostError::InvalidArgs("provider endpoint has no host".into()))?;
    match url.port() {
        Some(port) => Ok(format!("{host}:{port}")),
        None => Ok(host.to_owned()),
    }
}

fn canonical_uri(url: &Url) -> String {
    let decoded = percent_decode_str(url.path()).collect::<Vec<_>>();
    let encoded = percent_encode_bytes(&decoded, AWS_URI_PATH_SET);
    if encoded.is_empty() {
        "/".into()
    } else {
        encoded
    }
}

fn canonical_query(url: &Url) -> String {
    let Some(query) = url.query() else {
        return String::new();
    };
    let mut pairs: Vec<(String, String)> = query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let (name, value) = part.split_once('=').unwrap_or((part, ""));
            (
                percent_encode_bytes(&percent_decode_str(name).collect::<Vec<_>>(), AWS_URI_SET),
                percent_encode_bytes(&percent_decode_str(value).collect::<Vec<_>>(), AWS_URI_SET),
            )
        })
        .collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn percent_encode_bytes(bytes: &[u8], set: &'static AsciiSet) -> String {
    let ascii = String::from_utf8_lossy(bytes);
    utf8_percent_encode(&ascii, set).to_string()
}

fn collapse_spaces(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], value: &[u8]) -> HostResult<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .map_err(|_| HostError::Internal("failed to initialize HMAC-SHA256".into()))?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use reqwest::header::CONTENT_TYPE;

    fn s3_profile() -> ProviderProfile {
        ProviderProfile {
            id: "s3".into(),
            provider_type: ProviderType::S3,
            name: "S3".into(),
            endpoint: "https://s3.example.test".into(),
            username: None,
            region: Some("us-east-1".into()),
            bucket: Some("my bucket".into()),
            prefix: "Granite/objects".into(),
            credential_id: "credential".into(),
            access_key_id: Some("ACCESS".into()),
        }
    }

    #[test]
    fn builds_tls_urls_with_bucket_prefix_and_query() {
        let profile = s3_profile();
        let url = build_provider_url(&profile, "objects/book one.pdf?versionId=a+b").expect("url");
        assert_eq!(url.scheme(), "https");
        assert_eq!(
            url.path(),
            "/my%20bucket/Granite/objects/objects/book%20one.pdf"
        );
        assert_eq!(url.query(), Some("versionId=a+b"));
        assert!(build_provider_url(&profile, "../escape").is_err());
    }

    #[test]
    fn rejects_plaintext_endpoints_and_injected_auth_headers() {
        let mut profile = s3_profile();
        profile.endpoint = "http://localhost:9000".into();
        assert!(build_provider_url(&profile, "book.pdf").is_err());
        let mut headers = BTreeMap::new();
        headers.insert("Authorization".into(), "Basic attacker".into());
        assert!(sanitize_headers(headers).is_err());
    }

    #[test]
    fn s3_signature_is_deterministic_and_covers_host_and_payload() {
        let profile = s3_profile();
        let url = build_provider_url(&profile, "book.pdf?partNumber=2").expect("url");
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
        let time = Utc
            .with_ymd_and_hms(2026, 11, 9, 12, 0, 0)
            .single()
            .expect("time");
        let authorization = sign_s3_request(
            &Method::PUT,
            &url,
            &mut headers,
            b"payload",
            "ACCESS",
            "SECRET",
            "us-east-1",
            time,
        )
        .expect("sign");
        assert!(authorization
            .starts_with("AWS4-HMAC-SHA256 Credential=ACCESS/20261109/us-east-1/s3/aws4_request"));
        assert!(authorization
            .contains("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date"));
        assert!(!authorization.contains("SECRET"));
    }

    #[test]
    fn canonical_query_sorts_encoded_parameters() {
        let url = Url::parse("https://example.test/path?z=hello%20world&a=2&a=1").expect("url");
        assert_eq!(canonical_query(&url), "a=1&a=2&z=hello%20world");
    }

    #[test]
    fn plugin_sources_require_https_without_embedded_credentials() {
        assert!(validate_plugin_source_url(
            &Url::parse("https://github.com/granite/plugins.zip").expect("url")
        )
        .is_ok());
        assert!(validate_plugin_source_url(
            &Url::parse("http://github.com/granite/plugins.zip").expect("url")
        )
        .is_err());
        assert!(validate_plugin_source_url(
            &Url::parse("https://user:secret@example.test/plugins.zip").expect("url")
        )
        .is_err());
    }

    #[test]
    fn plugin_archive_limit_is_capped_at_twenty_mebibytes() {
        assert_eq!(MAX_PLUGIN_ARCHIVE_BYTES, 20 * 1024 * 1024);
    }
}
