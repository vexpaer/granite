package com.granite.androidbridge

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.io.ByteArrayOutputStream
import java.io.FileDescriptor
import java.io.InputStream

/**
 * Reads small URI ranges without materializing the complete document.
 *
 * Seekable SAF descriptors use a channel position. Providers without seek
 * support are skipped exactly, using bounded read-ahead only.
 */
internal object UriRangeReader {
    fun size(context: Context, uri: Uri, fallbackLength: Long): Long {
        context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
            if (descriptor.length >= 0) return descriptor.length
        }
        if (fallbackLength > 0) return fallbackLength

        val input = context.openUriInputStream(uri)
            ?: throw BridgeFailure("Android could not inspect the document")
        return input.use(::countBytes)
    }

    fun read(context: Context, uri: Uri, offset: Long, length: Int): ByteArray {
        if (offset < 0 || length < 0) {
            throw BridgeFailure("Document range offset and length must not be negative")
        }
        if (length == 0) return ByteArray(0)

        context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
            val start = descriptor.startOffset
            if (start < 0 || offset > Long.MAX_VALUE - start) {
                throw BridgeFailure("Document range position is invalid")
            }
            val duplicate = descriptor.parcelFileDescriptor?.dup()
                ?: throw BridgeFailure("Android could not duplicate the document descriptor")
            ParcelFileDescriptor.AutoCloseInputStream(duplicate).use { fileInput ->
                if (isSeekable(fileInput.fd)) {
                    fileInput.channel.position(start + offset)
                    return readBounded(fileInput, length)
                }
                skipExactly(fileInput, start + offset)
                return readBounded(fileInput, length)
            }
        }

        val input = context.openUriInputStream(uri)
            ?: throw BridgeFailure("Android could not open the document")
        return input.use {
            skipExactly(it, offset)
            readBounded(it, length)
        }
    }

    private fun countBytes(input: InputStream): Long {
        val buffer = ByteArray(BUFFER_SIZE)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return total
            total = Math.addExact(total, read.toLong())
        }
    }

    private fun skipExactly(input: InputStream, offset: Long) {
        var remaining = offset
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
                continue
            }
            if (input.read() < 0) {
                throw BridgeFailure("Document range starts after the end of the file")
            }
            remaining--
        }
    }

    private fun readBounded(input: InputStream, length: Int): ByteArray {
        val output = ByteArrayOutputStream(length)
        val buffer = ByteArray(minOf(BUFFER_SIZE, length))
        var remaining = length
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size, remaining))
            if (read < 0) break
            output.write(buffer, 0, read)
            remaining -= read
        }
        return output.toByteArray()
    }

    private fun isSeekable(fileDescriptor: FileDescriptor): Boolean {
        return try {
            Os.lseek(fileDescriptor, 0, OsConstants.SEEK_CUR) >= 0
        } catch (_: Exception) {
            false
        }
    }

    private const val BUFFER_SIZE = 64 * 1024
}
