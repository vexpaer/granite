package com.granite.androidbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BookSafetyRulesTest {
    private val bookId = "00000000-0000-4000-8000-000000000001"
    private val hash = "0123456789abcdef".repeat(4)

    @Test
    fun managedBookPathsUseBooksUuidNameAndRestrictCleanup() {
        val path = BookSafetyRules.managedRelativePath(bookId, "Research Book.pdf")
        assertEquals("books/$bookId/Research Book.pdf", path)
        assertTrue(BookSafetyRules.isManagedRelativePath(path))
        assertFalse(BookSafetyRules.isManagedRelativePath("Research Book.pdf"))
        assertFalse(BookSafetyRules.isManagedRelativePath("books/not-a-uuid/Research Book.pdf"))
        assertFalse(BookSafetyRules.isManagedRelativePath("books/$bookId/../Research Book.pdf"))
        assertFalse(BookSafetyRules.isManagedRelativePath("books/$bookId/Research Book.exe"))
    }

    @Test
    fun managedLayoutRejectsUnsafeNamesAndNonCanonicalIds() {
        assertThrows(BridgeFailure::class.java) {
            BookSafetyRules.managedRelativePath("not-a-uuid", "book.pdf")
        }
        assertThrows(BridgeFailure::class.java) {
            BookSafetyRules.managedRelativePath(bookId, "../book.pdf")
        }
    }

    @Test
    fun expectedSha256IsValidatedNormalizedAndComparedBeforeMutation() {
        assertEquals(hash, BookSafetyRules.normalizeExpectedSha256(hash.uppercase()))
        assertThrows(BridgeFailure::class.java) {
            BookSafetyRules.normalizeExpectedSha256("abc")
        }

        BookSafetyRules.requireExpectedHash(hash, hash.uppercase())
        val mismatch = assertThrows(BridgeFailure::class.java) {
            BookSafetyRules.requireExpectedHash("f".repeat(64), hash)
        }
        assertTrue(mismatch.message.orEmpty().contains("current file was preserved"))
    }

    @Test
    fun sourceMustRemainUnchangedAcrossTheWritePreparation() {
        BookSafetyRules.requireUnchanged(hash, hash.uppercase())
        val mismatch = assertThrows(BridgeFailure::class.java) {
            BookSafetyRules.requireUnchanged("f".repeat(64), hash)
        }
        assertTrue(mismatch.message.orEmpty().contains("expected SHA-256 $hash"))
    }
}
