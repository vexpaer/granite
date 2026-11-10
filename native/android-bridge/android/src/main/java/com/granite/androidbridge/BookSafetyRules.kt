package com.granite.androidbridge

import java.util.Locale
import java.util.UUID

/** Pure book-layout and write-precondition checks used by Android SAF tests. */
internal object BookSafetyRules {
    private val SHA256_PATTERN = Regex("^[0-9a-fA-F]{64}$")
    private val BOOK_EXTENSIONS = setOf("epub", "pdf", "txt", "mobi")

    fun managedRelativePath(bookId: String, safeName: String): String {
        val normalizedId = canonicalUuid(bookId)
            ?: throw BridgeFailure("Managed book id must be a canonical UUID")
        if (!isSafeManagedName(safeName)) {
            throw BridgeFailure("Managed book filename is unsafe")
        }
        return "books/$normalizedId/$safeName"
    }

    fun isManagedRelativePath(relativePath: String): Boolean {
        val parts = relativePath.split('/')
        return parts.size == 3 &&
            parts[0] == "books" &&
            canonicalUuid(parts[1]) != null &&
            isSafeManagedName(parts[2])
    }

    fun normalizeExpectedSha256(value: String?): String? {
        if (value == null) return null
        if (!SHA256_PATTERN.matches(value)) {
            throw BridgeFailure(
                "expectedSha256 must contain exactly 64 hexadecimal characters",
            )
        }
        return value.lowercase(Locale.ROOT)
    }

    fun requireExpectedHash(actualHash: String, expectedHash: String?) {
        if (expectedHash == null || actualHash.equals(expectedHash, ignoreCase = true)) return
        throw bookChanged(actualHash, expectedHash)
    }

    fun requireUnchanged(actualHash: String, initialHash: String) {
        if (actualHash.equals(initialHash, ignoreCase = true)) return
        throw bookChanged(actualHash, initialHash)
    }

    private fun bookChanged(actualHash: String, expectedHash: String): BridgeFailure {
        return BridgeFailure(
            "book changed after it was loaded; expected SHA-256 $expectedHash, " +
                "found $actualHash; the current file was preserved",
        )
    }

    private fun canonicalUuid(value: String): String? {
        val parsed = try {
            UUID.fromString(value)
        } catch (_: IllegalArgumentException) {
            return null
        }
        val canonical = parsed.toString()
        return canonical.takeIf { it.equals(value, ignoreCase = true) }
    }

    private fun isSafeManagedName(value: String): Boolean {
        if (
            value.isBlank() ||
            value == "." ||
            value == ".." ||
            value.startsWith('.') ||
            value.contains('/') ||
            value.contains('\\') ||
            value.any { it.isISOControl() }
        ) {
            return false
        }
        val extension = value.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return extension in BOOK_EXTENSIONS
    }
}
