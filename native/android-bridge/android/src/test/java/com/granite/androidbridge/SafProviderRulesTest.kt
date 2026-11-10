package com.granite.androidbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SafProviderRulesTest {
    private val prefix = listOf(".granite-provider")
    private val etag = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    @Test
    fun conditionalWriteHonorsStrongIfMatchAndCreateOnlyIfNoneMatch() {
        assertEquals(
            null,
            SafProviderRules.writePreconditionStatus(
                ifMatch = "\"$etag\"",
                ifNoneMatch = null,
                currentEtag = etag,
                exists = true,
            ),
        )
        assertEquals(
            412,
            SafProviderRules.writePreconditionStatus(
                ifMatch = "\"stale\"",
                ifNoneMatch = null,
                currentEtag = etag,
                exists = true,
            ),
        )
        assertEquals(
            412,
            SafProviderRules.writePreconditionStatus(
                ifMatch = "*",
                ifNoneMatch = null,
                currentEtag = null,
                exists = false,
            ),
        )
        assertEquals(
            412,
            SafProviderRules.writePreconditionStatus(
                ifMatch = null,
                ifNoneMatch = "*",
                currentEtag = etag,
                exists = true,
            ),
        )
        assertEquals(
            null,
            SafProviderRules.writePreconditionStatus(
                ifMatch = null,
                ifNoneMatch = "*",
                currentEtag = null,
                exists = false,
            ),
        )
    }

    @Test
    fun weakEtagsOnlySatisfyIfNoneMatch() {
        assertFalse(SafProviderRules.strongEtagMatches("W/\"$etag\"", etag, true))
        assertTrue(SafProviderRules.weakEtagMatches("W/\"$etag\"", etag, true))
        assertEquals(
            304,
            SafProviderRules.readPreconditionStatus(
                ifMatch = null,
                ifNoneMatch = "W/\"$etag\"",
                currentEtag = etag,
            ),
        )
    }

    @Test
    fun deleteKeyMustStayBelowDedicatedPrefix() {
        assertEquals(
            listOf(".granite-provider", "sync", "device-a.json"),
            SafProviderRules.validateKey(
                ".granite-provider/sync/device-a.json",
                prefix,
            ),
        )

        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey(".granite-provider", prefix)
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey("Granite/sync/device-a.json", prefix)
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey(".granite-provider-evil/device-a.json", prefix)
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey(".granite-provider/../book.epub", prefix)
        }
    }

    @Test
    fun prefixAndKeysRejectEmptyTraversalAndControlCharacters() {
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.relativeParts("", "Provider prefix")
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.relativeParts("../Granite", "Provider prefix")
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey(".granite-provider/a\u0000b", prefix)
        }
        assertThrows(BridgeFailure::class.java) {
            SafProviderRules.validateKey("/.granite-provider/a", prefix)
        }
    }

    @Test
    fun sha256HeaderMustBeExactlySixtyFourHexCharacters() {
        assertTrue(SafProviderRules.isSha256Hex(etag))
        assertFalse(SafProviderRules.isSha256Hex("a".repeat(63)))
        assertFalse(SafProviderRules.isSha256Hex("g".repeat(64)))
    }
}
