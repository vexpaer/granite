package com.granite.androidbridge

/** Pure validation and conditional-request rules for the SAF provider. */
internal object SafProviderRules {
    fun relativeParts(value: String, label: String): List<String> {
        if (
            value.isEmpty() ||
            value.length > MAX_RELATIVE_PATH_LENGTH ||
            value.startsWith('/') ||
            value.endsWith('/') ||
            value.contains('\\') ||
            value.any { it.isISOControl() }
        ) {
            throw BridgeFailure("Invalid $label")
        }
        val parts = value.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) {
            throw BridgeFailure("Invalid $label")
        }
        return parts
    }

    fun validateKey(
        rawKey: String,
        prefixParts: List<String>,
        allowPrefixRoot: Boolean = false,
        allowTrailingSlash: Boolean = false,
    ): List<String> {
        val key = if (allowTrailingSlash && rawKey.endsWith('/')) {
            rawKey.dropLast(1)
        } else {
            rawKey
        }
        val parts = relativeParts(key, "Provider key")
        if (
            parts.size < prefixParts.size ||
            parts.take(prefixParts.size) != prefixParts
        ) {
            throw BridgeFailure("Provider key is outside the dedicated profile prefix")
        }
        if (!allowPrefixRoot && parts.size == prefixParts.size) {
            throw BridgeFailure("Provider operation requires an object below the profile prefix")
        }
        return parts
    }

    fun writePreconditionStatus(
        ifMatch: String?,
        ifNoneMatch: String?,
        currentEtag: String?,
        exists: Boolean,
    ): Int? {
        if (ifMatch != null && !strongEtagMatches(ifMatch, currentEtag, exists)) return 412
        if (ifNoneMatch != null && weakEtagMatches(ifNoneMatch, currentEtag, exists)) return 412
        return null
    }

    fun readPreconditionStatus(
        ifMatch: String?,
        ifNoneMatch: String?,
        currentEtag: String?,
    ): Int? {
        if (ifMatch != null && !strongEtagMatches(ifMatch, currentEtag, true)) return 412
        if (ifNoneMatch != null && weakEtagMatches(ifNoneMatch, currentEtag, true)) return 304
        return null
    }

    fun strongEtagMatches(
        value: String,
        currentEtag: String?,
        exists: Boolean,
    ): Boolean {
        if (value.trim() == "*") return exists
        if (!exists || currentEtag == null) return false
        return value.split(',').any { candidate ->
            val normalized = normalizeEtag(candidate, allowWeak = false)
            normalized != null && normalized.equals(currentEtag, ignoreCase = true)
        }
    }

    fun weakEtagMatches(
        value: String,
        currentEtag: String?,
        exists: Boolean,
    ): Boolean {
        if (value.trim() == "*") return exists
        if (!exists || currentEtag == null) return false
        return value.split(',').any { candidate ->
            val normalized = normalizeEtag(candidate, allowWeak = true)
            normalized != null && normalized.equals(currentEtag, ignoreCase = true)
        }
    }

    fun isSha256Hex(value: String): Boolean {
        return value.length == 64 && value.all {
            it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F'
        }
    }

    private fun normalizeEtag(value: String, allowWeak: Boolean): String? {
        var tag = value.trim()
        if (tag.startsWith("W/", ignoreCase = true)) {
            if (!allowWeak) return null
            tag = tag.substring(2).trim()
        }
        if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) {
            tag = tag.substring(1, tag.length - 1)
        }
        return tag.takeIf { it.isNotEmpty() }
    }

    private const val MAX_RELATIVE_PATH_LENGTH = 4096
}
