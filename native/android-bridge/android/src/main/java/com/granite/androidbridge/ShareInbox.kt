package com.granite.androidbridge

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID

internal class ShareInbox(private val context: Context) {
    private val inboxDirectory = File(context.filesDir, "granite-shared-imports")
    private val indexFile = File(inboxDirectory, "index.json")

    @Synchronized
    fun captureIntent(intent: Intent?): Int {
        if (intent == null) return 0
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) {
            return 0
        }

        ensureInbox()
        val records = readIndex()
        val existingUris = records.mapNotNull { it.optString("sourceUri").takeIf(String::isNotBlank) }.toSet()
        val captured = mutableListOf<StoredShare>()

        for (uri in sharedUris(intent)) {
            val source = uri.toString()
            if (source in existingUris) continue
            val name = androidDisplayName(uri)
                ?: uri.lastPathSegment?.substringAfterLast('/')
                ?: "shared-book"
            if (bookExtension(name) == null) continue

            val cacheFileName = "${UUID.randomUUID()}-${safeFilename(name)}"
            val id = UUID.randomUUID().toString()
            val destination = File(inboxDirectory, cacheFileName)
            try {
                val copied = copySharedUri(uri, destination)
                captured += StoredShare(
                    id = id,
                    cacheFileName = cacheFileName,
                    name = name,
                    size = copied.size,
                    sha256 = copied.sha256,
                    receivedAt = BridgeClock.nowMillis(),
                )
                records += JSONObject()
                    .put("id", id)
                    .put("sourceUri", source)
                    .put("cacheFileName", cacheFileName)
                    .put("name", name)
                    .put("size", copied.size)
                    .put("sha256", copied.sha256)
                    .put("receivedAt", BridgeClock.nowMillis())
            } catch (_: Exception) {
                destination.delete()
            }
        }

        if (captured.isNotEmpty() && !writeIndex(records)) {
            for (record in captured) {
                File(inboxDirectory, record.cacheFileName).delete()
            }
            throw BridgeFailure("Android could not persist the share inbox")
        }
        return captured.size
    }

    @Synchronized
    fun consume(): JSArray {
        ensureInbox()
        val records = readIndex()
        if (records.isEmpty()) return JSArray()

        val output = JSArray()
        for (record in records) {
            val id = record.optString("id")
            val cacheFileName = record.optString("cacheFileName")
            val name = record.optString("name")
            if (id.isBlank() || cacheFileName.isBlank() || name.isBlank()) {
                throw BridgeFailure("Android share inbox metadata is corrupt")
            }
            val file = File(inboxDirectory, cacheFileName)
            if (!file.isFile) {
                throw BridgeFailure("A shared book is no longer available")
            }
            output.put(
                JSObject()
                    .put("id", id)
                    .put("name", name)
                    .put("size", file.length()),
            )
        }
        return output
    }

    @Synchronized
    fun read(id: String): JSObject {
        ensureInbox()
        val record = readIndex().firstOrNull { it.optString("id") == id }
            ?: throw BridgeFailure("The shared book is no longer in the inbox")
        val cacheFileName = record.optString("cacheFileName")
        val name = record.optString("name")
        if (cacheFileName.isBlank() || name.isBlank()) {
            throw BridgeFailure("Android share inbox metadata is corrupt")
        }
        val file = File(inboxDirectory, cacheFileName)
        if (!file.isFile) throw BridgeFailure("A shared book is no longer available")
        val bytes = file.readBytes()
        val expectedHash = record.optString("sha256")
        if (bytes.size.toLong() != record.optLong("size") || sha256(bytes) != expectedHash) {
            throw BridgeFailure("A shared book failed integrity verification")
        }
        return JSObject()
            .put("id", id)
            .put("name", name)
            .put("bytes", bytesToJsArray(bytes))
    }

    @Synchronized
    fun acknowledge(ids: Set<String>): Int {
        if (ids.isEmpty()) return 0
        ensureInbox()
        val records = readIndex()
        if (records.isEmpty()) return 0

        val retained = mutableListOf<JSONObject>()
        val removedFiles = mutableListOf<File>()
        var acknowledged = 0
        for (record in records) {
            val id = record.optString("id")
            if (id in ids) {
                acknowledged++
                record.optString("cacheFileName")
                    .takeIf(String::isNotBlank)
                    ?.let { removedFiles += File(inboxDirectory, it) }
            } else {
                retained += record
            }
        }
        if (acknowledged == 0) return 0
        if (!writeIndex(retained)) {
            throw BridgeFailure("Android could not acknowledge imported shared books")
        }
        for (file in removedFiles) {
            if (!file.delete() && file.exists()) {
                // The index no longer references this private cache file, so it cannot be imported twice.
            }
        }
        return acknowledged
    }

    @Synchronized
    fun pendingCount(): Int = if (indexFile.isFile) readIndex().size else 0

    private fun sharedUris(intent: Intent): List<Uri> {
        val uris = linkedSetOf<Uri>()
        val clipData: ClipData? = intent.clipData
        if (clipData != null) {
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index).uri?.let(uris::add)
            }
        }

        if (intent.action == Intent.ACTION_SEND) {
            parcelableUri(intent, Intent.EXTRA_STREAM)?.let(uris::add)
        } else {
            val streams: List<Uri>? = if (Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            }
            streams?.let(uris::addAll)
        }
        return uris.toList()
    }

    private fun parcelableUri(intent: Intent, name: String): Uri? {
        return if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(name, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(name)
        }
    }

    private fun androidDisplayName(uri: Uri): String? {
        return context.contentResolver.query(
            uri,
            arrayOf(android.provider.OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index) else null
            } else {
                null
            }
        }
    }

    private fun copySharedUri(uri: Uri, destination: File): HashAndSize {
        val input = context.contentResolver.openInputStream(uri)
            ?: throw BridgeFailure("Android could not open a shared book")
        val digest = MessageDigest.getInstance("SHA-256")
        var size = 0L
        input.use { source ->
            FileOutputStream(destination).use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    output.write(buffer, 0, read)
                    digest.update(buffer, 0, read)
                    size += read
                }
                output.flush()
                output.fd.sync()
            }
        }
        return HashAndSize(digest.digest().toHex(), size)
    }

    private fun ensureInbox() {
        if (!inboxDirectory.exists() && !inboxDirectory.mkdirs()) {
            throw BridgeFailure("Android could not create the private share inbox")
        }
    }

    private fun readIndex(): MutableList<JSONObject> {
        if (!indexFile.isFile) return mutableListOf()
        return try {
            val array = JSONArray(indexFile.readText(Charsets.UTF_8))
            MutableList(array.length()) { index -> array.getJSONObject(index) }
        } catch (_: Exception) {
            throw BridgeFailure("Android share inbox metadata is corrupt")
        }
    }

    private fun writeIndex(records: List<JSONObject>): Boolean {
        ensureInbox()
        val temporary = File(inboxDirectory, "index-${UUID.randomUUID()}.tmp")
        val backup = File(inboxDirectory, "index-${UUID.randomUUID()}.bak")
        var previousMoved = false
        var replacementMoved = false
        return try {
            val json = JSONArray()
            for (record in records) json.put(record)
            FileOutputStream(temporary).use { output ->
                output.write(json.toString().toByteArray(Charsets.UTF_8))
                output.flush()
                output.fd.sync()
            }
            if (indexFile.exists()) {
                if (!indexFile.renameTo(backup)) return false
                previousMoved = true
            }
            if (!temporary.renameTo(indexFile)) {
                if (previousMoved) backup.renameTo(indexFile)
                return false
            }
            replacementMoved = true
            if (previousMoved && !backup.delete() && backup.exists()) {
                throw BridgeFailure("Android could not finalize the share inbox index")
            }
            true
        } catch (_: Exception) {
            temporary.delete()
            if (previousMoved && !replacementMoved && backup.exists() && !indexFile.exists()) {
                backup.renameTo(indexFile)
            }
            false
        }
    }

    private fun safeFilename(name: String): String {
        return name
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace(Regex("[\\u0000\\r\\n]"), "_")
            .take(180)
            .ifBlank { "shared-book" }
    }

    private fun bookExtension(name: String): String? {
        return name.substringAfterLast('.', "").lowercase(Locale.ROOT)
            .takeIf { it in SUPPORTED_EXTENSIONS }
    }

    private data class HashAndSize(val sha256: String, val size: Long)

    companion object {
        private val SUPPORTED_EXTENSIONS = setOf("epub", "pdf", "txt", "mobi")
    }
}
