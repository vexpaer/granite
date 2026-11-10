package com.granite.androidbridge

import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class NotebookAttachmentRulesTest {
    private val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 1)
    private val hash = sha256(bytes)
    private val path = "attachments/sha256/$hash/photo.png"

    @Test
    fun attachmentPathsMaterializeRelativeToTheMarkdownParent() {
        val parsed = NotebookAttachmentRules.portablePath(path)
        assertEquals(hash, parsed.sha256)
        assertEquals("photo.png", parsed.safeName)
        assertEquals(
            "Research/Week 1/attachments/sha256/$hash/photo.png",
            NotebookAttachmentRules.relativeToNote(
                "Research/Week 1/Note.md",
                parsed,
            ),
        )
    }

    @Test
    fun rejectsTraversalEncodingAndNonContentAddressedPaths() {
        val invalid = listOf(
            "../secret.txt",
            "/attachments/sha256/$hash/photo.png",
            "attachments\\sha256\\$hash\\photo.png",
            "attachments/sha256/${hash.uppercase()}/photo.png",
            "attachments/sha256/$hash/../photo.png",
            "attachments/sha256/$hash/%2e%2e",
            "attachments/sha256/$hash/sub%2fphoto.png",
            "attachments/other/$hash/photo.png",
            "attachments/sha256/$hash/",
        )
        for (candidate in invalid) {
            assertThrows(BridgeFailure::class.java) {
                NotebookAttachmentRules.portablePath(candidate)
            }
        }
    }

    @Test
    fun decodesPortableDataAndVerifiesTheContentAddress() {
        val encoded = Base64.getEncoder().encodeToString(bytes)
        val decoded = NotebookAttachmentRules.decodeDataUrl(
            "data:image/png;charset=utf-8;base64,$encoded",
            hash,
        )
        assertEquals("image/png", decoded.mediaType)
        assertArrayEquals(bytes, decoded.bytes)
    }

    @Test
    fun rejectsMismatchedOrMalformedAttachmentContent() {
        assertThrows(BridgeFailure::class.java) {
            NotebookAttachmentRules.decodeDataUrl(
                "data:text/plain;base64,${Base64.getEncoder().encodeToString(byteArrayOf(1))}",
                hash,
            )
        }
        assertThrows(BridgeFailure::class.java) {
            NotebookAttachmentRules.decodeDataUrl(
                "data:text/plain,not-base64",
                hash,
            )
        }
    }
}
