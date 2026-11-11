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
                    if (name == INTERNAL_DIRECTORY_NAME || name == NOTEBOOK_DIRECTORY_NAME) {
                        continue
                    }
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

    fun statBook(root: JsonNode, relativePath: String): JSObject {
        val file = resolveFile(rootDirectory(root), relativePath)
        return JSObject().put(
            "size",
            UriRangeReader.size(context, file.uri, file.length()),
        )
    }

    fun readBookRange(
        root: JsonNode,
        relativePath: String,
        offset: Long,
        length: Long,
    ): ByteArray {
        val range = BookRangeRules.validate(offset, length)
        val file = resolveFile(rootDirectory(root), relativePath)
        val size = UriRangeReader.size(context, file.uri, file.length())
        BookRangeRules.validateBounds(size, range)
        val bytes = UriRangeReader.read(context, file.uri, range.offset, range.length)
        if (bytes.size != range.length) {
            throw BridgeFailure("Book changed during the ranged read")
        }
        return bytes
    }

    fun locateBook(root: JsonNode, relativePath: String): Boolean {
        return findExistingFile(rootDirectory(root), relativePath)?.isFile == true
    }

    fun trashBook(root: JsonNode, relativePath: String, bookId: String): JSObject {
        if (root.path("kind").asText() != "saf") {
            throw BridgeFailure("Android book.trash requires a SAF library root")
        }
        val tree = rootDirectory(root)
        requireWritable(tree)
        if (!BookSafetyRules.isManagedRelativePath(relativePath)) {
            throw BridgeFailure("Only Granite-managed books can be moved to recoverable trash")
        }
        rejectProtectedRelativePath(relativePath)
        val expectedName = safeRelativeParts(relativePath).last()
        val safeBookId = safePathComponent(bookId, "book ID")
        val source = findExistingFile(tree, relativePath)
        if (source == null) {
            if (hasTrashCopy(tree, safeBookId, expectedName)) {
                return JSObject().put("trashed", true)
            }
            throw BridgeFailure("Book file is missing")
        }
        if (!source.isFile || !source.exists()) {
            throw BridgeFailure("Book file is missing")
        }
        val sourceName = source.name
            ?: throw BridgeFailure("Cannot resolve the book filename")
        val sourceParent = source.parentFile
            ?: throw BridgeFailure("Cannot resolve the book's parent folder")
        val internal = ensureDirectory(tree, INTERNAL_DIRECTORY_NAME)
        val trash = ensureDirectory(internal, TRASH_DIRECTORY_NAME)
        val perBook = ensureDirectory(trash, safeBookId)
        val trashName = uniqueName(
            perBook,
            "${System.currentTimeMillis()}-${UUID.randomUUID()}-${sanitizeFilename(sourceName)}",
        )
        val sourceBeforeMove = hashDocument(source)
        val destination = perBook.createFile(
            source.type ?: mimeTypeForName(sourceName),
            trashName,
        ) ?: throw BridgeFailure("The selected folder does not allow a trash copy")

        try {
            val copied = copyDocument(source, destination)
            val destinationBeforeDelete = hashDocument(destination)
            if (
                copied != sourceBeforeMove ||
                destinationBeforeDelete != sourceBeforeMove
            ) {
                throw BridgeFailure("Book trash copy verification failed")
            }

            if (!source.delete()) {
                throw BridgeFailure("The selected provider did not remove the original book")
            }

            val destinationAfterMove = hashDocument(destination)
            if (destinationAfterMove != sourceBeforeMove) {
                restoreBook(sourceParent, sourceName, destination, sourceBeforeMove)
                throw BridgeFailure(
                    "Book trash verification failed after removal; the original was restored",
                )
            }

            try {
                if (sourceParent.listFiles().isEmpty()) sourceParent.delete()
            } catch (_: Exception) {
                // Empty managed-directory cleanup is best effort after the
                // verified trash move has already completed.
            }
            return JSObject().put("trashed", true)
        } catch (exception: Exception) {
            if (!source.exists() && destination.exists()) {
                try {
                    restoreBook(sourceParent, sourceName, destination, sourceBeforeMove)
                } catch (restoreError: Exception) {
                    throw BridgeFailure(
                        "Book trash failed after removing the original; " +
                            "the trash copy was retained and restore also failed: " +
                            (restoreError.message ?: exception.message ?: "unknown error"),
                    )
                }
            }
            throw exception
        }
    }

    fun importBook(root: JsonNode, requestedName: String, bytes: ByteArray): ImportedBook {
        if (bytes.isEmpty()) {
            throw BridgeFailure("refusing to import an empty book file")
        }
        val tree = rootDirectory(root)
        requireWritable(tree)
        val safeName = sanitizeFilename(requestedName)
        if (bookFormat(safeName) == null) {
            throw BridgeFailure("Unsupported book format")
        }

        val books = ensureDirectory(tree, MANAGED_BOOKS_DIRECTORY)
        val bookId = UUID.randomUUID().toString()
        val relativePath = BookSafetyRules.managedRelativePath(bookId, safeName)
        val bookDirectory = books.createDirectory(bookId)
            ?: throw BridgeFailure("The selected folder does not allow managed book storage")
        if (bookDirectory.name != bookId || !bookDirectory.isDirectory) {
            bookDirectory.delete()
            throw BridgeFailure("The SAF provider changed the managed book directory name")
        }
        var file: DocumentFile? = null

        try {
            val created = bookDirectory.createFile(mimeTypeForName(safeName), safeName)
                ?: throw BridgeFailure("The selected folder does not allow file creation")
            file = created
            val actualName = created.name
                ?: throw BridgeFailure("The SAF provider did not expose the managed filename")
            if (actualName != safeName || !created.isFile) {
                throw BridgeFailure("The SAF provider changed the managed book filename")
            }
            writeDocument(created, bytes)
            val verification = hashDocument(created)
            val expected = sha256(bytes)
            if (verification.size != bytes.size.toLong() || verification.sha256 != expected) {
                created.delete()
                throw BridgeFailure("Book copy verification failed")
            }
            return ImportedBook(
                name = actualName,
                relativePath = relativePath,
                sha256 = expected,
                size = bytes.size.toLong(),
            )
        } catch (exception: Exception) {
            file?.takeIf(DocumentFile::exists)?.delete()
            if (bookDirectory.listFiles().isEmpty()) bookDirectory.delete()
            throw exception
        }
    }

    fun writeBook(
        root: JsonNode,
        relativePath: String,
        bytes: ByteArray,
        expectedSha256: String?,
    ): JSObject {
        if (bytes.isEmpty()) {
            throw BridgeFailure("refusing to replace a book with an empty file")
        }
        val requiredCurrentHash = BookSafetyRules.normalizeExpectedSha256(expectedSha256)
        val tree = rootDirectory(root)
        requireWritable(tree)
        val target = resolveFile(tree, relativePath)
        val parent = target.parentFile
            ?: throw BridgeFailure("Cannot resolve the book's parent folder")
        val originalName = target.name
            ?: throw BridgeFailure("Cannot resolve the book filename")
        val replacementHash = sha256(bytes)
        val currentAtStart = hashDocument(target)
        BookSafetyRules.requireExpectedHash(currentAtStart.sha256, requiredCurrentHash)
        var backup: DocumentFile? = null
        var temporary: DocumentFile? = null
        var originalRemoved = false

        try {
            backup = copyToUniqueBackup(parent, target, originalName, currentAtStart)
            temporary = parent.createFile(
                "application/octet-stream",
                ".granite-tmp-${UUID.randomUUID()}-${sanitizeFilename(originalName)}",
            ) ?: throw BridgeFailure("The folder does not allow a temporary file")
            writeDocument(temporary, bytes)

            val temporaryHash = hashDocument(temporary)
            if (
                temporaryHash.size != bytes.size.toLong() ||
                temporaryHash.sha256 != replacementHash
            ) {
                throw BridgeFailure("Temporary book write verification failed")
            }

            replaceDocument(parent, target, temporary, originalName, currentAtStart) {
                originalRemoved = true
            }
            temporary = null

            val replacement = findExistingFile(tree, relativePath)
                ?: throw BridgeFailure("Book disappeared after replacement")
            val finalHash = hashDocument(replacement)
            if (
                finalHash.size != bytes.size.toLong() ||
                finalHash.sha256 != replacementHash
            ) {
                throw BridgeFailure("Final book write verification failed")
            }

            backup?.delete()
            backup = null
            return JSObject()
                .put("sha256", replacementHash)
                .put("size", bytes.size.toLong())
        } catch (exception: Exception) {
            temporary?.delete()
            var rollbackFailure: Exception? = null
            if (originalRemoved) {
                try {
                    backup?.let { restoreBackup(tree, relativePath, it, currentAtStart) }
                    backup = null
                } catch (error: Exception) {
                    rollbackFailure = error
                }
            } else {
                backup?.delete()
                backup = null
            }
            if (rollbackFailure != null) {
                throw BridgeFailure(
                    "Book write failed and rollback also failed; the verified backup was " +
                        "retained in the managed book directory: " +
                        (rollbackFailure.message ?: exception.message ?: "unknown error"),
                )
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

    fun sizeUri(uri: Uri): Long {
        resolver.query(
            uri,
            arrayOf(OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (index >= 0 && !cursor.isNull(index)) {
                    return cursor.getLong(index).coerceAtLeast(0L)
                }
            }
        }
        return DocumentFile.fromSingleUri(context, uri)?.length()?.coerceAtLeast(0L) ?: 0L
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

    private fun rejectProtectedRelativePath(relativePath: String) {
        val first = relativePath.replace('\\', '/').substringBefore('/')
        if (first == INTERNAL_DIRECTORY_NAME || first == NOTEBOOK_DIRECTORY_NAME) {
            throw BridgeFailure("Granite metadata and Notebook files cannot be trashed as books")
        }
    }

    private fun safePathComponent(input: String, label: String): String {
        if (
            input.isBlank() ||
            input.length > 180 ||
            input == "." ||
            input == ".." ||
            input.startsWith('/') ||
            input.contains('/') ||
            input.contains('\\') ||
            input.contains('\u0000')
        ) {
            throw BridgeFailure("Invalid $label")
        }
        return input
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

    private fun ensureDirectory(parent: DocumentFile, name: String): DocumentFile {
        val existing = parent.findFile(name)
        if (existing != null) {
            if (!existing.isDirectory) {
                throw BridgeFailure("Granite metadata path is not a folder")
            }
            return existing
        }
        return parent.createDirectory(name)
            ?: throw BridgeFailure("The selected folder does not allow Granite managed storage")
    }

    private fun hasTrashCopy(tree: DocumentFile, bookId: String, originalName: String): Boolean {
        val internal = tree.findFile(INTERNAL_DIRECTORY_NAME)
            ?.takeIf(DocumentFile::isDirectory)
            ?: return false
        val trash = internal.findFile(TRASH_DIRECTORY_NAME)
            ?.takeIf(DocumentFile::isDirectory)
            ?: return false
        val perBook = trash.findFile(bookId)
            ?.takeIf(DocumentFile::isDirectory)
            ?: return false
        val suffix = "-${sanitizeFilename(originalName)}"
        return perBook.listFiles().any { file ->
            file.isFile && file.name?.endsWith(suffix) == true
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

    private fun restoreBook(
        parent: DocumentFile,
        originalName: String,
        trashCopy: DocumentFile,
        expected: HashResult,
    ) {
        if (parent.findFile(originalName) != null) {
            throw BridgeFailure(
                "Book trash verification failed and the restore target already exists",
            )
        }
        val restored = parent.createFile(
            trashCopy.type ?: mimeTypeForName(originalName),
            originalName,
        ) ?: throw BridgeFailure(
            "Book trash verification failed and the original could not be restored",
        )
        val copied = copyDocument(trashCopy, restored)
        val verified = hashDocument(restored)
        if (copied != expected || verified != expected) {
            throw BridgeFailure(
                "Book trash verification failed and restored-byte verification failed",
            )
        }
    }

    private fun copyToUniqueBackup(
        parent: DocumentFile,
        source: DocumentFile,
        originalName: String,
        expectedSource: HashResult,
    ): DocumentFile {
        val timestamp = System.currentTimeMillis()
        val backupName = uniqueName(parent, "$originalName.granite-backup-$timestamp")
        val backup = parent.createFile(source.type ?: mimeTypeForName(originalName), backupName)
            ?: throw BridgeFailure("The folder does not allow a safety backup")
        try {
            val sourceHash = copyDocument(source, backup)
            val backupHash = hashDocument(backup)
            if (sourceHash != expectedSource || backupHash != expectedSource) {
                throw BridgeFailure(
                    "Book changed while creating the safety backup; " +
                        "the current file was preserved",
                )
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
        expectedSource: HashResult,
        onOriginalRemoved: () -> Unit,
    ) {
        BookSafetyRules.requireUnchanged(hashDocument(target).sha256, expectedSource.sha256)
        if (!target.delete()) {
            throw BridgeFailure("The selected provider does not allow safe replacement")
        }
        onOriginalRemoved()
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
        expected: HashResult,
    ) {
        val name = safeRelativeParts(relativePath).last()
        val parent = backup.parentFile ?: tree
        val current = parent.findFile(name)
        if (current != null && !current.delete()) {
            throw BridgeFailure("Book replacement failed and the damaged file could not be removed")
        }
        if (backup.renameTo(name)) {
            val restored = parent.findFile(name)
                ?: throw BridgeFailure("Book replacement failed and the backup disappeared")
            if (hashDocument(restored) != expected) {
                throw BridgeFailure("Book replacement failed and restored-byte verification failed")
            }
        } else {
            val restored = parent.createFile(backup.type ?: mimeTypeForName(name), name)
                ?: throw BridgeFailure("Book replacement failed and the backup could not be restored")
            val copied = copyDocument(backup, restored)
            val verified = hashDocument(restored)
            if (copied != expected || verified != expected) {
                throw BridgeFailure("Book replacement failed and backup verification failed")
            }
        }
    }

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
        private const val MANAGED_BOOKS_DIRECTORY = "books"
        private const val INTERNAL_DIRECTORY_NAME = ".granite"
        private const val NOTEBOOK_DIRECTORY_NAME = "Notebook"
        private const val TRASH_DIRECTORY_NAME = "trash"
        private val SUPPORTED_BOOK_EXTENSIONS = setOf("epub", "pdf", "txt", "mobi")
    }
}
