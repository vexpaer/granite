package com.granite.androidbridge

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.documentfile.provider.DocumentFile
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.databind.JsonNode
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

internal class SafFileSystem(private val context: Context) {
    private val resolver: ContentResolver = context.contentResolver
    private val defaultStorage = AndroidDefaultStorage(context)
    @Volatile
    private var migrationCancelled = false

    fun pickRootResult(uri: Uri): JSObject {
        val document = documentFromUri(uri)
        if (!document.isDirectory) throw BridgeFailure("The selected location is not a folder")

        val persisted = context.contentResolver.persistedUriPermissions.any {
            it.uri == uri && it.isReadPermission
        }
        if (!persisted) {
            throw BridgeFailure("Android did not grant persistent access to the selected folder")
        }

        return rootObject(uri, document)
    }

    fun validateRoot(root: JsonNode): JSObject {
        if (root.path("kind").asText() == "filesystem") {
            return defaultStorage.validateRoot(root)
        }
        val uri = rootUri(root)
        val document = DocumentFile.fromTreeUri(context, uri)
        val persisted = resolver.persistedUriPermissions.firstOrNull { it.uri == uri }
        val permission = when {
            document == null || !document.exists() || !document.isDirectory ||
                persisted == null || !persisted.isReadPermission -> "unavailable"
            !persisted.isWritePermission || !document.canWrite() -> "readonly"
            !document.canRead() -> "denied"
            else -> "granted"
        }

        val result = JSObject(root.toString())
        result.put("permission", permission)
        result.put("readonly", permission == "readonly")
        result.put("lastValidatedAt", BridgeClock.nowIso())
        return result
    }

    fun scan(root: JsonNode): JSArray {
        val tree = rootDirectory(root)
        val output = JSArray()
        val pending = ArrayDeque<Pair<DocumentFile, String>>()
        val visited = HashSet<String>()
        pending.add(tree to "")

        while (pending.isNotEmpty()) {
            val (directory, prefix) = pending.removeFirst()
            if (!visited.add(directory.uri.toString())) continue
            val children = directory.listFiles()
            for (child in children) {
                val name = child.name ?: continue
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (child.isDirectory) {
                    if (relative.length <= MAX_RELATIVE_PATH_LENGTH) {
                        pending.add(child to relative)
                    }
                    continue
                }
                if (!child.isFile) continue
                val format = bookFormat(name) ?: continue
                output.put(
                    JSObject()
                        .put("name", name)
                        .put("relativePath", relative)
                        .put("size", child.length().coerceAtLeast(0L))
                        .put("format", format),
                )
            }
        }
        return output
    }

    fun readBook(root: JsonNode, relativePath: String): ByteArray {
        val file = resolveFile(rootDirectory(root), relativePath)
        return readDocument(file)
    }

    fun locateBook(root: JsonNode, relativePath: String): Boolean {
        return findExistingFile(rootDirectory(root), relativePath)?.isFile == true
    }

    fun importBook(root: JsonNode, requestedName: String, bytes: ByteArray): ImportedBook {
        val tree = rootDirectory(root)
        requireWritable(tree)
        val safeName = sanitizeFilename(requestedName)
        if (bookFormat(safeName) == null) {
            throw BridgeFailure("Unsupported book format")
        }

        val uniqueName = uniqueName(tree, safeName)
        val file = tree.createFile(mimeTypeForName(uniqueName), uniqueName)
            ?: throw BridgeFailure("The selected folder does not allow file creation")
        val actualName = file.name ?: uniqueName

        try {
            writeDocument(file, bytes)
            val verification = hashDocument(file)
            val expected = sha256(bytes)
            if (verification.size != bytes.size.toLong() || verification.sha256 != expected) {
                file.delete()
                throw BridgeFailure("Book copy verification failed")
            }
            return ImportedBook(
                name = actualName,
                relativePath = actualName,
                sha256 = expected,
                size = bytes.size.toLong(),
            )
        } catch (exception: Exception) {
            if (file.exists()) file.delete()
            throw exception
        }
    }

    fun writeBook(root: JsonNode, relativePath: String, bytes: ByteArray): JSObject {
        val tree = rootDirectory(root)
        requireWritable(tree)
        val target = resolveFile(tree, relativePath)
        val parent = target.parentFile
            ?: throw BridgeFailure("Cannot resolve the book's parent folder")
        val originalName = target.name
            ?: throw BridgeFailure("Cannot resolve the book filename")
        val expectedHash = sha256(bytes)
        var backup: DocumentFile? = null
        var temporary: DocumentFile? = null

        try {
            backup = copyToUniqueBackup(parent, target, originalName)
            temporary = parent.createFile(
                "application/octet-stream",
                ".granite-tmp-${UUID.randomUUID()}-${sanitizeFilename(originalName)}",
            ) ?: throw BridgeFailure("The folder does not allow a temporary file")
            writeDocument(temporary, bytes)

            val temporaryHash = hashDocument(temporary)
            if (temporaryHash.size != bytes.size.toLong() || temporaryHash.sha256 != expectedHash) {
                throw BridgeFailure("Temporary book write verification failed")
            }

            replaceDocument(parent, target, temporary, originalName)
            temporary = null

            val replacement = findExistingFile(tree, relativePath)
                ?: throw BridgeFailure("Book disappeared after replacement")
            val finalHash = hashDocument(replacement)
            if (finalHash.size != bytes.size.toLong() || finalHash.sha256 != expectedHash) {
                restoreBackup(tree, relativePath, backup)
                throw BridgeFailure("Final book verification failed; the backup was restored")
            }

            return JSObject()
                .put("sha256", expectedHash)
                .put("size", bytes.size.toLong())
        } catch (exception: Exception) {
            temporary?.delete()
            if (backup != null && (!findExistingFile(tree, relativePath)?.isFile.orTrue())) {
                restoreBackup(tree, relativePath, backup)
            }
            throw exception
        }
    }

    fun migrate(fromRoot: JsonNode, toRoot: JsonNode): JSObject {
        migrationCancelled = false
        val sourceTree = rootDirectory(fromRoot)
        val destinationTree = rootDirectory(toRoot)
        requireWritable(destinationTree)

        var copied = 0
        var skipped = 0
        var failed = 0
        val items = JSArray()
        val pending = ArrayDeque<Triple<DocumentFile, DocumentFile, String>>()
        pending.add(Triple(sourceTree, destinationTree, ""))

        while (pending.isNotEmpty() && !migrationCancelled) {
            val (sourceDirectory, destinationDirectory, prefix) = pending.removeFirst()
            for (source in sourceDirectory.listFiles()) {
                if (migrationCancelled) break
                val name = source.name ?: continue
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (source.isDirectory) {
                    val destination = destinationDirectory.findFile(name)
                        ?: destinationDirectory.createDirectory(sanitizeFilename(name))
                    if (destination == null || !destination.isDirectory) {
                        failed++
                        items.put(JSObject().put("relativePath", relative).put("status", "error"))
                        continue
                    }
                    pending.add(Triple(source, destination, relative))
                    continue
                }
                if (!source.isFile) continue

                val existing = destinationDirectory.findFile(name)
                if (existing != null) {
                    skipped++
                    items.put(JSObject().put("relativePath", relative).put("status", "skipped"))
                    continue
                }

                val destination = destinationDirectory.createFile(
                    source.type ?: mimeTypeForName(name),
                    sanitizeFilename(name),
                )
                if (destination == null) {
                    failed++
                    items.put(JSObject().put("relativePath", relative).put("status", "error"))
                    continue
                }

                try {
                    val sourceHash = copyDocument(source, destination)
                    val destinationHash = hashDocument(destination)
                    if (sourceHash != destinationHash) {
                        destination.delete()
                        throw BridgeFailure("Copied file verification failed")
                    }
                    copied++
                    items.put(JSObject().put("relativePath", relative).put("status", "copied"))
                } catch (_: Exception) {
                    if (destination.exists()) destination.delete()
                    failed++
                    items.put(JSObject().put("relativePath", relative).put("status", "error"))
                }
            }
        }

        return JSObject()
            .put("copied", copied)
            .put("skipped", skipped)
            .put("failed", failed)
            .put("cancelled", migrationCancelled)
            .put("items", items)
    }

    fun cancelMigration(): Boolean {
        migrationCancelled = true
        return true
    }

    fun readUri(uri: Uri): Pair<String, ByteArray> {
        val name = displayName(uri) ?: uri.lastPathSegment ?: "imported-book"
        val input = context.openUriInputStream(uri)
            ?: throw BridgeFailure("Android could not open the selected book")
        val bytes = input.use { readAll(it) }
        return name to bytes
    }

    fun writeExport(uri: Uri, bytes: ByteArray) {
        val output = context.openUriOutputStream(uri, "wt")
            ?: context.openUriOutputStream(uri, "w")
            ?: throw BridgeFailure("Android could not create the export file")
        output.use { stream ->
            stream.write(bytes)
            stream.flush()
        }
        val verificationInput = context.openUriInputStream(uri)
            ?: throw BridgeFailure("Android could not verify the export file")
        val verification = verificationInput.use { hashStream(it) }
        if (verification.size != bytes.size.toLong() || verification.sha256 != sha256(bytes)) {
            throw BridgeFailure("Export verification failed")
        }
    }

    fun displayName(uri: Uri): String? {
        resolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) return cursor.getString(index)
            }
        }
        return null
    }

    private fun rootObject(uri: Uri, document: DocumentFile): JSObject {
        val displayName = document.name?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')
            ?: "Granite Library"
        val writeGranted = document.canWrite()
        return JSObject()
            .put("id", UUID.nameUUIDFromBytes("granite-saf:$uri".toByteArray()).toString())
            .put("displayName", displayName)
            .put("path", uri.toString())
            .put("kind", "saf")
            .put("permission", if (writeGranted) "granted" else "readonly")
            .put("enabled", true)
            .put("isDefault", false)
            .put("readonly", !writeGranted)
            .put("scanState", "idle")
            .put("lastValidatedAt", BridgeClock.nowIso())
    }

    private fun rootDirectory(root: JsonNode): DocumentFile {
        if (root.path("kind").asText() == "filesystem") {
            return defaultStorage.directoryFor(root)
        }
        val tree = DocumentFile.fromTreeUri(context, rootUri(root))
            ?: throw BridgeFailure("Library root cannot be opened")
        if (!tree.exists() || !tree.isDirectory) {
            throw BridgeFailure("Library root is unavailable")
        }
        if (!tree.canRead()) {
            throw BridgeFailure("Read access to the library root is unavailable")
        }
        return tree
    }

    private fun rootUri(root: JsonNode): Uri {
        val raw = optionalString(root, "path") ?: optionalString(root, "uri")
            ?: throw BridgeFailure("Library root has no SAF URI")
        val uri = Uri.parse(raw)
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
            throw BridgeFailure("Android library roots must use a content:// SAF URI")
        }
        return uri
    }

    private fun documentFromUri(uri: Uri): DocumentFile {
        if (DocumentsContract.isTreeUri(uri)) {
            return DocumentFile.fromTreeUri(context, uri)
                ?: throw BridgeFailure("Android could not open the selected folder")
        }
        val treeDocumentId = DocumentsContract.getDocumentId(uri)
        val treeUri = DocumentsContract.buildTreeDocumentUri(uri.authority, treeDocumentId)
        return DocumentFile.fromTreeUri(context, treeUri)
            ?: throw BridgeFailure("Android could not open the selected folder")
    }

    private fun requireWritable(tree: DocumentFile) {
        if (!tree.canWrite()) throw BridgeFailure("The library root is read-only")
    }

    private fun resolveFile(tree: DocumentFile, relativePath: String): DocumentFile {
        val parts = safeRelativeParts(relativePath)
        var current = tree
        for (part in parts) {
            current = current.findFile(part)
                ?: throw BridgeFailure("Book file is missing")
        }
        if (!current.isFile || !current.exists()) throw BridgeFailure("Book file is missing")
        return current
    }

    private fun findExistingFile(tree: DocumentFile, relativePath: String): DocumentFile? {
        val parts = safeRelativeParts(relativePath)
        var current: DocumentFile? = tree
        for (part in parts) {
            current = current?.findFile(part) ?: return null
        }
        return current
    }

    private fun safeRelativeParts(relativePath: String): List<String> {
        if (relativePath.isBlank() || relativePath.length > MAX_RELATIVE_PATH_LENGTH) {
            throw BridgeFailure("Invalid book relative path")
        }
        if (relativePath.startsWith('/') || relativePath.contains('\u0000')) {
            throw BridgeFailure("Invalid book relative path")
        }
        val normalized = relativePath.replace('\\', '/')
        val parts = normalized.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) {
            throw BridgeFailure("Invalid book relative path")
        }
        return parts
    }

    private fun sanitizeFilename(input: String): String {
        val cleaned = input
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace('\u0000', '_')
            .replace('\r', '_')
            .replace('\n', '_')
            .trim()
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") {
            throw BridgeFailure("Invalid filename")
        }
        return cleaned.take(180)
    }

    private fun uniqueName(parent: DocumentFile, requestedName: String): String {
        if (parent.findFile(requestedName) == null) return requestedName
        val dot = requestedName.lastIndexOf('.')
        val stem = if (dot > 0) requestedName.substring(0, dot) else requestedName
        val extension = if (dot > 0) requestedName.substring(dot) else ""
        var counter = 1
        while (true) {
            val candidate = "$stem ($counter)$extension"
            if (parent.findFile(candidate) == null) return candidate
            counter++
        }
    }

    private fun writeDocument(file: DocumentFile, bytes: ByteArray) {
        val output = context.openUriOutputStream(file.uri, "wt")
            ?: context.openUriOutputStream(file.uri, "w")
            ?: throw BridgeFailure("The selected folder does not allow writing")
        output.use { it.write(bytes); it.flush() }
    }

    private fun readDocument(file: DocumentFile): ByteArray {
        val input = context.openUriInputStream(file.uri)
            ?: throw BridgeFailure("Android could not open the book")
        return input.use { readAll(it) }
    }

    private fun readAll(input: InputStream): ByteArray {
        val maxBridgeBytes = minOf(
            Int.MAX_VALUE.toLong() - 8,
            Runtime.getRuntime().maxMemory() / 6,
        )
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > maxBridgeBytes) {
                throw BridgeFailure("File is too large for the host_call byte-array contract")
            }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private data class HashResult(val sha256: String, val size: Long)

    private fun hashDocument(file: DocumentFile): HashResult {
        val input = context.openUriInputStream(file.uri)
            ?: throw BridgeFailure("Android could not verify the book")
        return input.use { hashStream(it) }
    }

    private fun hashStream(input: InputStream): HashResult {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var size = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
            size += read
        }
        return HashResult(digest.digest().toHex(), size)
    }

    private fun copyDocument(source: DocumentFile, destination: DocumentFile): HashResult {
        val input = context.openUriInputStream(source.uri)
            ?: throw BridgeFailure("Android could not read the source file")
        val output = context.openUriOutputStream(destination.uri, "wt")
            ?: context.openUriOutputStream(destination.uri, "w")
            ?: throw BridgeFailure("Android could not write the destination file")
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var size = 0L
        input.use { sourceStream ->
            output.use { destinationStream ->
                while (true) {
                    val read = sourceStream.read(buffer)
                    if (read < 0) break
                    destinationStream.write(buffer, 0, read)
                    digest.update(buffer, 0, read)
                    size += read
                }
                destinationStream.flush()
            }
        }
        return HashResult(digest.digest().toHex(), size)
    }

    private fun copyToUniqueBackup(
        parent: DocumentFile,
        source: DocumentFile,
        originalName: String,
    ): DocumentFile {
        val timestamp = System.currentTimeMillis()
        val backupName = uniqueName(parent, "$originalName.granite-backup-$timestamp")
        val backup = parent.createFile(source.type ?: mimeTypeForName(originalName), backupName)
            ?: throw BridgeFailure("The folder does not allow a safety backup")
        try {
            val sourceHash = copyDocument(source, backup)
            val backupHash = hashDocument(backup)
            if (sourceHash != backupHash) {
                throw BridgeFailure("Safety backup verification failed")
            }
            return backup
        } catch (exception: Exception) {
            if (backup.exists()) backup.delete()
            throw exception
        }
    }

    private fun replaceDocument(
        parent: DocumentFile,
        target: DocumentFile,
        temporary: DocumentFile,
        originalName: String,
    ) {
        if (!target.delete()) {
            throw BridgeFailure("The selected provider does not allow safe replacement")
        }
        if (temporary.renameTo(originalName)) return

        val replacement = parent.createFile(mimeTypeForName(originalName), originalName)
            ?: throw BridgeFailure("The book could not be recreated after replacement")
        copyDocument(temporary, replacement)
        if (!temporary.delete()) {
            // The temporary file is harmless and is removed by the next successful cleanup.
        }
    }

    private fun restoreBackup(
        tree: DocumentFile,
        relativePath: String,
        backup: DocumentFile,
    ) {
        val name = safeRelativeParts(relativePath).last()
        val parent = backup.parentFile ?: tree
        val current = parent.findFile(name)
        if (current != null && !current.delete()) {
            throw BridgeFailure("Book replacement failed and the damaged file could not be removed")
        }
        if (!backup.renameTo(name)) {
            val restored = parent.createFile(backup.type ?: mimeTypeForName(name), name)
                ?: throw BridgeFailure("Book replacement failed and the backup could not be restored")
            val copied = copyDocument(backup, restored)
            val verified = hashDocument(restored)
            if (copied != verified) {
                throw BridgeFailure("Book replacement failed and backup verification failed")
            }
        }
    }

    private fun Boolean?.orTrue(): Boolean = this ?: true

    private fun mimeTypeForName(name: String): String = when (bookFormat(name)) {
        "epub" -> "application/epub+zip"
        "pdf" -> "application/pdf"
        "txt" -> "text/plain"
        "mobi" -> "application/x-mobipocket-ebook"
        else -> "application/octet-stream"
    }

    private fun bookFormat(name: String): String? {
        val extension = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return extension.takeIf { it in SUPPORTED_BOOK_EXTENSIONS }
    }

    companion object {
        private const val MAX_RELATIVE_PATH_LENGTH = 4096
        private val SUPPORTED_BOOK_EXTENSIONS = setOf("epub", "pdf", "txt", "mobi")
    }
}
