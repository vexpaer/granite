package com.granite.androidbridge

import java.util.Base64
import java.util.Locale

/** Pure validation and decoding for portable Notebook attachment records. */
internal object NotebookAttachmentRules {
    data class PortablePath(
        val value: String,
        val sha256: String,
        val safeName: String,
        val parts: List<String>,
    )

    data class DecodedData(
        val bytes: ByteArray,
        val mediaType: String,
    )

    fun portablePath(value: String): PortablePath {
        if (
            value.isBlank() ||
            value != value.trim() ||
            value.length > MAX_PATH_LENGTH ||
            value.startsWith('/') ||
            value.contains('\\') ||
            value.any { it.isISOControl() }
        ) {
            throw BridgeFailure("Notebook attachment path is unsafe")
        }
        val match = PATH_PATTERN.matchEntire(value)
            ?: throw BridgeFailure("Notebook attachment path is not content-addressed")
        val hash = match.groupValues[1]
        val safeName = match.groupValues[2]
        if (!isSafeName(safeName)) {
            throw BridgeFailure("Notebook attachment filename is unsafe")
        }
        return PortablePath(
            value = value,
            sha256 = hash,
            safeName = safeName,
            parts = value.split('/'),
        )
    }

    fun relativeToNote(noteRelativePath: String, attachment: PortablePath): String {
        val noteParts = noteParts(noteRelativePath)
        return (noteParts.dropLast(1) + attachment.parts).joinToString("/")
    }

    fun decodeDataUrl(value: String, expectedHash: String): DecodedData {
        if (!value.startsWith("data:", ignoreCase = true)) {
            throw BridgeFailure("Notebook attachment data is not a Data URL")
        }
        val comma = value.indexOf(',')
        if (comma < 5) {
            throw BridgeFailure("Notebook attachment Data URL has no payload")
        }
        val metadata = value.substring(5, comma).split(';')
        if (metadata.none { it.trim().equals("base64", ignoreCase = true) }) {
            throw BridgeFailure("Notebook attachment Data URL must use base64")
        }
        val encoded = value.substring(comma + 1)
            .filterNot { it.isWhitespace() }
        if (encoded.isEmpty() || encoded.length % 4 == 1) {
            throw BridgeFailure("Notebook attachment base64 payload is invalid")
        }
        val bytes = try {
            Base64.getDecoder().decode(encoded)
        } catch (_: IllegalArgumentException) {
            throw BridgeFailure("Notebook attachment base64 payload is invalid")
        }
        val actualHash = sha256(bytes)
        if (!actualHash.equals(expectedHash, ignoreCase = false)) {
            throw BridgeFailure(
                "Notebook attachment content does not match its content address",
            )
        }
        return DecodedData(bytes = bytes, mediaType = mediaType(metadata.firstOrNull()))
    }

    private fun noteParts(relativePath: String): List<String> {
        if (
            relativePath.isBlank() ||
            relativePath.startsWith('/') ||
            relativePath.length > MAX_PATH_LENGTH ||
            relativePath.contains('\\') ||
            relativePath.any { it.isISOControl() }
        ) {
            throw BridgeFailure("Notebook note path is unsafe for attachments")
        }
        val parts = relativePath.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) {
            throw BridgeFailure("Notebook note path contains traversal components")
        }
        return parts
    }

    private fun isSafeName(value: String): Boolean {
        return value.isNotEmpty() &&
            value.length <= MAX_NAME_LENGTH &&
            value != "." &&
            value != ".." &&
            !value.startsWith('.') &&
            !value.startsWith('-') &&
            value.none { it.isISOControl() } &&
            SAFE_NAME_PATTERN.matches(value) &&
            value.substringBefore('.').lowercase(Locale.ROOT) !in WINDOWS_RESERVED_NAMES &&
            !value.endsWith('.') &&
            !value.endsWith(' ')
    }

    private fun mediaType(value: String?): String {
        val normalized = value
            ?.trim()
            ?.lowercase(Locale.ROOT)
            ?.takeIf { MEDIA_TYPE_PATTERN.matches(it) }
        return normalized ?: "application/octet-stream"
    }

    private val PATH_PATTERN =
        Regex("^attachments/sha256/([0-9a-f]{64})/([^/]+)$")
    private val MEDIA_TYPE_PATTERN =
        Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")
    private val SAFE_NAME_PATTERN = Regex("^[\\p{L}\\p{N}._ -]+$")
    private val WINDOWS_RESERVED_NAMES = setOf(
        "con",
        "prn",
        "aux",
        "nul",
        "com1",
        "com2",
        "com3",
        "com4",
        "com5",
        "com6",
        "com7",
        "com8",
        "com9",
        "lpt1",
        "lpt2",
        "lpt3",
        "lpt4",
        "lpt5",
        "lpt6",
        "lpt7",
        "lpt8",
        "lpt9",
    )
    private const val MAX_PATH_LENGTH = 4096
    private const val MAX_NAME_LENGTH = 120
}
