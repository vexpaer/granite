package com.granite.androidbridge

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.dataformat.yaml.YAMLGenerator
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper
import app.tauri.plugin.JSObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

/**
 * Android equivalent of src-tauri/src/notebook.rs.
 *
 * The SQLite/state document remains authoritative for the application. On
 * state.save the host mirrors Notes into Markdown. On state.load the host reads
 * Markdown edits back and may save the returned AppData document.
 */
internal class NotebookSafMirror(
    private val context: Context,
    private val defaultStorage: AndroidDefaultStorage,
) {
    private val jsonMapper = ObjectMapper()
    private val yamlMapper = YAMLMapper()
        .disable(YAMLGenerator.Feature.WRITE_DOC_START_MARKER)

    fun mirror(state: JsonNode): JSObject {
        val selection = selectRoot(state, requireWrite = true) ?: return JSObject()
            .put("skipped", true)
            .put("reason", "No writable SAF library root is configured")
        val root = selection.document
        val notebook = findOrCreateDirectory(root, NOTEBOOK_DIRECTORY)
            ?: throw BridgeFailure("The selected SAF root does not allow creating the Notebook folder")
        val previousIndex = loadIndex(notebook)
        val nextIndex = jsonMapper.createObjectNode()
        nextIndex.put("schemaVersion", INDEX_SCHEMA_VERSION)
        val nextEntries = nextIndex.putObject("entries")
        val usedPaths = HashSet<String>()
        val activeIds = HashSet<String>()
        var mirrored = 0

        val notes = state.get("notes")
        if (notes != null && !notes.isArray) {
            throw BridgeFailure("state.notes must be an array before Notebook mirroring")
        }

        for (note in notes ?: jsonMapper.createArrayNode()) {
            if (!note.isObject) throw BridgeFailure("A Notebook note is not an object")
            val id = note.path("id").takeIf(JsonNode::isTextual)?.asText()
                ?.takeIf(String::isNotBlank)
                ?: throw BridgeFailure("A Notebook note has no stable id")
            val title = note.path("title").takeIf(JsonNode::isTextual)?.asText()
                ?.trim()?.takeIf(String::isNotEmpty)
                ?: "Untitled"
            val folder = note.path("folder").takeIf(JsonNode::isTextual)?.asText() ?: ""
            val body = note.path("body").takeIf(JsonNode::isTextual)?.asText()
                ?: throw BridgeFailure("Notebook note '$id' has no string body")
            val relativePath = selectNotePath(
                id = id,
                title = title,
                folder = folder,
                indexedPath = previousIndex.entries[id],
                usedPaths = usedPaths,
            )
            val document = renderMarkdown(note as ObjectNode, id, title, folder, body)
            val bytes = document.toByteArray(Charsets.UTF_8)
            writeAtomic(notebook, relativePath, "text/markdown", bytes)

            val entry = nextEntries.putObject(id)
            entry.put("relativePath", relativePath)
            entry.put("sha256", sha256(bytes))
            activeIds += id
            mirrored++
        }
        writeAtomic(
            notebook,
            "$INDEX_DIRECTORY/$INDEX_FILE",
            "application/json",
            jsonMapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(nextIndex),
        )

        for ((id, entry) in previousIndex.entries) {
            if (id in activeIds || entry.relativePath.endsWith(".md").not()) continue
            resolveFile(notebook, entry.relativePath)?.delete()
        }

        return JSObject()
            .put("skipped", false)
            .put("rootId", selection.rootId)
            .put("mirrored", mirrored)
    }

    fun sync(state: JsonNode): JsonNode {
        val selection = selectRoot(state, requireWrite = false) ?: return state.deepCopy()
        val notebook = findDirectory(selection.document, NOTEBOOK_DIRECTORY)
            ?: return state.deepCopy()
        val index = loadIndex(notebook)
        val diskNotes = scanMarkdown(notebook)
        val byId = LinkedHashMap<String, DiskNote>()
        for (note in diskNotes) {
            if (byId.put(note.id, note) != null) {
                throw BridgeFailure("Multiple Markdown files declare the same Granite note ID")
            }
        }

        val updated = state.deepCopy<JsonNode>()
        if (!updated.isObject) {
            throw BridgeFailure("Stored state must be an object to sync Notebook files")
        }
        val stateObject = updated as ObjectNode
        val notes = when (val field = stateObject.get("notes")) {
            null -> stateObject.putArray("notes")
            is ArrayNode -> field
            else -> throw BridgeFailure("state.notes must be an array")
        }

        val missingManagedIds = index.entries.filter { (_, entry) ->
            resolveFile(notebook, entry.relativePath) == null
        }.keys
        val retained = jsonMapper.createArrayNode()
        for (note in notes) {
            val id = note.path("id").takeIf(JsonNode::isTextual)?.asText()
            if (id == null || id !in missingManagedIds) retained.add(note)
        }
        stateObject.set<ArrayNode>("notes", retained)

        val existingById = HashMap<String, ObjectNode>()
        for (note in retained) {
            if (!note.isObject) {
                throw BridgeFailure("A stored Notebook note is not an object")
            }
            note.path("id").takeIf(JsonNode::isTextual)?.asText()?.let {
                existingById[it] = note as ObjectNode
            }
        }

        for ((id, diskNote) in byId) {
            val existing = existingById[id]
            if (existing != null) {
                existing.put("title", diskNote.title)
                existing.put("body", diskNote.body)
                existing.put("folder", diskNote.folder)
                existing.put("updatedAt", diskNote.updatedAt)
                mergeOptionalMetadata(existing, diskNote.metadata)
                continue
            }

            val note = jsonMapper.createObjectNode()
            note.put("id", id)
            note.put("title", diskNote.title)
            note.put("body", diskNote.body)
            note.put("folder", diskNote.folder)
            note.putArray("tagIds")
            note.put("createdAt", diskNote.updatedAt)
            note.put("updatedAt", diskNote.updatedAt)
            mergeOptionalMetadata(note, diskNote.metadata)
            retained.add(note)
        }
        return updated
    }

    private data class RootSelection(
        val rootId: String,
        val document: DocumentFile,
    )

    private data class IndexEntry(val relativePath: String)

    private data class NotebookIndex(val entries: Map<String, IndexEntry>)

    private data class DiskNote(
        val relativePath: String,
        val id: String,
        val title: String,
        val body: String,
        val folder: String,
        val metadata: ObjectNode,
        val updatedAt: String,
    )

    private fun selectRoot(state: JsonNode, requireWrite: Boolean): RootSelection? {
        val roots = state.get("roots")
        if (roots == null || !roots.isArray) return null
        var fallback: RootSelection? = null
        for (root in roots) {
            if (!root.path("enabled").asBoolean(true)) continue
            val permission = root.path("permission").asText()
            if (permission != "granted" && permission != "readonly") continue
            if (requireWrite && permission != "granted") continue
            val document = try {
                when (root.path("kind").asText()) {
                    "filesystem" -> defaultStorage.directoryFor(root)
                    "saf" -> {
                        val rawUri = root.path("path").takeIf(JsonNode::isTextual)?.asText()
                            ?: continue
                        DocumentFile.fromTreeUri(context, Uri.parse(rawUri))
                    }
                    else -> null
                }
            } catch (_: Exception) {
                null
            } ?: continue
            if (!document.exists() || !document.isDirectory || !document.canRead()) continue
            if (requireWrite && !document.canWrite()) continue
            val selection = RootSelection(
                root.path("id").takeIf(JsonNode::isTextual)?.asText() ?: document.uri.toString(),
                document,
            )
            if (root.path("isDefault").asBoolean(false)) return selection
            if (fallback == null) fallback = selection
        }
        return fallback
    }

    private fun renderMarkdown(
        note: ObjectNode,
        id: String,
        title: String,
        folder: String,
        body: String,
    ): String {
        val metadata = jsonMapper.createObjectNode()
        metadata.put("graniteNoteId", id)
        metadata.put("title", title)
        metadata.put("folder", folder)
        for (key in OPTIONAL_NOTE_METADATA) {
            note.get(key)?.let { metadata.set<JsonNode>(key, it.deepCopy()) }
        }
        val yaml = yamlMapper.writeValueAsString(metadata).trimEnd()
        return "---\n$yaml\n---\n\n$body"
    }

    private fun scanMarkdown(notebook: DocumentFile): List<DiskNote> {
        val result = mutableListOf<DiskNote>()
        val pending = ArrayDeque<Pair<DocumentFile, String>>()
        val visited = HashSet<String>()
        pending.add(notebook to "")
        while (pending.isNotEmpty()) {
            val (directory, prefix) = pending.removeFirst()
            if (!visited.add(directory.uri.toString())) continue
            for (child in directory.listFiles()) {
                val name = child.name ?: continue
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"
                if (relative.length > MAX_RELATIVE_PATH_LENGTH) continue
                if (child.isDirectory) {
                    if (!name.startsWith('.') && name != "attachments") {
                        pending.add(child to relative)
                    }
                    continue
                }
                if (!child.isFile || !name.lowercase(Locale.ROOT).endsWith(".md")) continue
                if (child.length() > MAX_MARKDOWN_BYTES) {
                    throw BridgeFailure("Markdown note exceeds the 64 MiB limit")
                }
                val content = readUtf8(child)
                result += parseDiskNote(relative, content, BridgeClock.isoFromMillis(child.lastModified()))
            }
        }
        return result.sortedBy { it.relativePath }
    }

    private fun parseDiskNote(relativePath: String, contentValue: String, modifiedAt: String): DiskNote {
        val content = contentValue.removePrefix("\uFEFF")
        val (metadata, body) = splitFrontmatter(content)
        val id = metadata.path("graniteNoteId").takeIf(JsonNode::isTextual)?.asText()
            ?: metadata.path("granite_note_id").takeIf(JsonNode::isTextual)?.asText()
            ?: uuidV5(NOTE_ID_NAMESPACE, relativePath.toByteArray(Charsets.UTF_8)).toString()
        val fallbackTitle = firstMarkdownHeading(body)
            ?: relativePath.substringAfterLast('/').removeSuffix(".md")
                .ifBlank { "Untitled" }
        val title = metadata.path("title").takeIf(JsonNode::isTextual)?.asText()
            ?.trim()?.takeIf(String::isNotEmpty)
            ?: fallbackTitle
        val folder = metadata.path("folder").takeIf(JsonNode::isTextual)?.asText()
            ?: relativePath.substringBeforeLast('/', "")
        val updatedAt = metadata.path("updatedAt").takeIf(JsonNode::isTextual)?.asText()
            ?: modifiedAt
        return DiskNote(relativePath, id, title, body, folder, metadata, updatedAt)
    }

    private fun splitFrontmatter(content: String): Pair<ObjectNode, String> {
        val normalized = content.replace("\r\n", "\n")
        if (!normalized.startsWith("---\n")) {
            return jsonMapper.createObjectNode() to content
        }
        val closing = normalized.indexOf("\n---", startIndex = 4)
        if (closing < 0) throw BridgeFailure("Markdown Note front matter has no closing delimiter")
        val yaml = normalized.substring(4, closing)
        val bodyStart = when {
            normalized.startsWith("\n", closing + 4) -> closing + 5
            else -> closing + 4
        }
        val parsed = try {
            yamlMapper.readTree(yaml)
        } catch (exception: Exception) {
            throw BridgeFailure("Markdown Note front matter is invalid YAML")
        }
        if (parsed == null || !parsed.isObject) {
            throw BridgeFailure("Note front matter must be a YAML object")
        }
        return parsed as ObjectNode to normalized.substring(bodyStart)
    }

    private fun firstMarkdownHeading(body: String): String? {
        return body.lineSequence()
            .mapNotNull { line -> line.takeIf { it.startsWith("# ") }?.removePrefix("# ")?.trim() }
            .firstOrNull { it.isNotEmpty() }
    }

    private fun mergeOptionalMetadata(note: ObjectNode, metadata: ObjectNode) {
        for (key in OPTIONAL_NOTE_METADATA) {
            metadata.get(key)?.let { note.set<JsonNode>(key, it.deepCopy()) }
        }
    }

    private fun selectNotePath(
        id: String,
        title: String,
        folder: String,
        indexedPath: String?,
        usedPaths: MutableSet<String>,
    ): String {
        if (indexedPath != null) {
            val normalized = indexedPath.replace('\\', '/')
            if (safeRelativePath(normalized) != null && usedPaths.add(normalized.lowercase(Locale.ROOT))) {
                return normalized
            }
        }

        val folderPath = safeFolder(folder)
        val titleStem = title.trim().removeSuffix(".md").trim().ifEmpty { "Untitled" }
        val safeTitle = sanitizeComponent(titleStem)
        var candidate = joinRelative(folderPath, "$safeTitle.md")
        if (!usedPaths.add(candidate.lowercase(Locale.ROOT))) {
            val suffix = id.take(8).ifBlank { stableKey(id).take(8) }
            candidate = joinRelative(folderPath, "$safeTitle-$suffix.md")
            if (!usedPaths.add(candidate.lowercase(Locale.ROOT))) {
                throw BridgeFailure("Could not derive a unique Markdown filename")
            }
        }
        return candidate
    }

    private fun safeFolder(folder: String): List<String> {
        if (folder.isBlank()) return emptyList()
        return folder.split('/', '\\').filter(String::isNotEmpty).map { part ->
            if (part == "." || part == "..") {
                throw BridgeFailure("Notebook folder cannot contain traversal components")
            }
            sanitizeComponent(part)
        }
    }

    private fun joinRelative(folder: List<String>, fileName: String): String {
        return (folder + fileName).joinToString("/")
    }

    private fun sanitizeComponent(input: String): String {
        val cleaned = input
            .replace(Regex("[<>:\"/\\\\|?*\\u0000-\\u001F]"), "_")
            .trim()
            .trimEnd('.', ' ')
            .take(120)
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") {
            throw BridgeFailure("Invalid Notebook path component")
        }
        return cleaned
    }

    private fun safeRelativePath(relativePath: String): List<String>? {
        if (relativePath.isBlank() || relativePath.startsWith('/') ||
            relativePath.length > MAX_RELATIVE_PATH_LENGTH || relativePath.contains('\u0000')
        ) {
            return null
        }
        val parts = relativePath.replace('\\', '/').split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return parts
    }

    private fun loadIndex(notebook: DocumentFile): NotebookIndex {
        val indexFile = findFile(notebook, "$INDEX_DIRECTORY/$INDEX_FILE") ?: return NotebookIndex(emptyMap())
        val root = try {
            jsonMapper.readTree(readUtf8(indexFile))
        } catch (_: Exception) {
            throw BridgeFailure("Notebook index is invalid")
        }
        val entriesNode = root.path("entries")
        if (!entriesNode.isObject) return NotebookIndex(emptyMap())
        val entries = LinkedHashMap<String, IndexEntry>()
        val fields = entriesNode.fields()
        while (fields.hasNext()) {
            val (id, entry) = fields.next()
            val relative = entry.path("relativePath").takeIf(JsonNode::isTextual)?.asText()
            if (relative != null && safeRelativePath(relative) != null) {
                entries[id] = IndexEntry(relative)
            }
        }
        return NotebookIndex(entries)
    }

    private fun findDirectory(root: DocumentFile, path: String): DocumentFile? {
        val parts = safeRelativePath(path) ?: return null
        var current: DocumentFile? = root
        for (part in parts) {
            current = current?.findFile(part) ?: return null
            if (current == null || !current.isDirectory) return null
        }
        return current
    }

    private fun findOrCreateDirectory(root: DocumentFile, path: String): DocumentFile? {
        val parts = safeRelativePath(path) ?: return null
        var current: DocumentFile? = root
        for (part in parts) {
            val existing = current?.findFile(part)
            current = existing ?: current?.createDirectory(part)
            if (current == null || !current.isDirectory) return null
        }
        return current
    }

    private fun findFile(root: DocumentFile, relativePath: String): DocumentFile? {
        val parts = safeRelativePath(relativePath) ?: return null
        var current: DocumentFile? = root
        for (part in parts) {
            current = current?.findFile(part) ?: return null
        }
        return current?.takeIf { it.isFile && it.exists() }
    }

    private fun resolveFile(root: DocumentFile, relativePath: String): DocumentFile? {
        return findFile(root, relativePath)
    }

    private fun ensureParent(root: DocumentFile, relativePath: String): Pair<DocumentFile, String> {
        val parts = safeRelativePath(relativePath)
            ?: throw BridgeFailure("Invalid Notebook relative path")
        var current = root
        for (part in parts.dropLast(1)) {
            current = current.findFile(part)
                ?: current.createDirectory(part)
                ?: throw BridgeFailure("The SAF root could not create a Notebook folder")
            if (!current.isDirectory) throw BridgeFailure("A Notebook path component is not a folder")
        }
        return current to parts.last()
    }

    private fun writeAtomic(root: DocumentFile, relativePath: String, mimeType: String, bytes: ByteArray) {
        val (parent, name) = ensureParent(root, relativePath)
        val target = parent.findFile(name)
        val temporary = parent.createFile(
            "application/octet-stream",
            ".granite-note-${UUID.randomUUID()}",
        ) ?: throw BridgeFailure("The SAF root does not allow a temporary Notebook file")
        try {
            writeBytes(temporary, bytes)
            if (sha256(readBytes(temporary)) != sha256(bytes)) {
                throw BridgeFailure("Temporary Notebook write verification failed")
            }

            var backup: DocumentFile? = null
            if (target != null) {
                backup = parent.createFile(
                    target.type ?: mimeType,
                    "$name.granite-backup-${System.currentTimeMillis()}",
                ) ?: throw BridgeFailure("The SAF root does not allow a Notebook safety backup")
                copy(target, backup)
                if (sha256(readBytes(backup)) != sha256(readBytes(target))) {
                    backup.delete()
                    throw BridgeFailure("Notebook safety backup verification failed")
                }
                if (!target.delete()) {
                    backup.delete()
                    throw BridgeFailure("The SAF provider does not allow Notebook replacement")
                }
            }

            if (!temporary.renameTo(name)) {
                val replacement = parent.createFile(mimeType, name)
                    ?: run {
                        restoreNotebookBackup(parent, name, backup)
                        throw BridgeFailure("The Notebook file could not be recreated")
                    }
                copy(temporary, replacement)
            }
            val finalFile = parent.findFile(name)
            if (finalFile == null || sha256(readBytes(finalFile)) != sha256(bytes)) {
                if (backup == null && finalFile != null) finalFile.delete()
                restoreNotebookBackup(parent, name, backup)
                throw BridgeFailure("Final Notebook write verification failed")
            }
        } finally {
            if (temporary.exists()) temporary.delete()
        }
    }

    private fun restoreNotebookBackup(parent: DocumentFile, name: String, backup: DocumentFile?) {
        if (backup == null) return
        val damaged = parent.findFile(name)
        if (damaged != null) damaged.delete()
        if (!backup.renameTo(name)) {
            val restored = parent.createFile(backup.type ?: "text/markdown", name) ?: return
            copy(backup, restored)
        }
    }

    private fun readBytes(file: DocumentFile): ByteArray {
        val input = context.openUriInputStream(file.uri)
            ?: throw BridgeFailure("Android could not open a Notebook file")
        return input.use { it.readBytes() }
    }

    private fun readUtf8(file: DocumentFile): String {
        if (file.length() > MAX_MARKDOWN_BYTES) {
            throw BridgeFailure("Markdown note exceeds the 64 MiB limit")
        }
        val bytes = readBytes(file)
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: Exception) {
            throw BridgeFailure("Markdown note is not valid UTF-8")
        }
    }

    private fun writeBytes(file: DocumentFile, bytes: ByteArray) {
        val output = context.openUriOutputStream(file.uri, "wt")
            ?: context.openUriOutputStream(file.uri, "w")
            ?: throw BridgeFailure("Android could not write a Notebook file")
        output.use {
            it.write(bytes)
            it.flush()
        }
    }

    private fun copy(source: DocumentFile, destination: DocumentFile) {
        val input = context.openUriInputStream(source.uri)
            ?: throw BridgeFailure("Android could not read a Notebook file")
        val output = context.openUriOutputStream(destination.uri, "wt")
            ?: context.openUriOutputStream(destination.uri, "w")
            ?: throw BridgeFailure("Android could not write a Notebook backup")
        input.use { sourceStream ->
            output.use { destinationStream ->
                sourceStream.copyTo(destinationStream)
                destinationStream.flush()
            }
        }
    }

    private fun uuidV5(namespace: UUID, name: ByteArray): UUID {
        val namespaceBytes = ByteBuffer.allocate(16)
            .putLong(namespace.mostSignificantBits)
            .putLong(namespace.leastSignificantBits)
            .array()
        val digest = MessageDigest.getInstance("SHA-1")
        digest.update(namespaceBytes)
        digest.update(name)
        val hash = digest.digest()
        hash[6] = ((hash[6].toInt() and 0x0f) or 0x50).toByte()
        hash[8] = ((hash[8].toInt() and 0x3f) or 0x80).toByte()
        val buffer = ByteBuffer.wrap(hash)
        return UUID(buffer.long, buffer.long)
    }

    companion object {
        private const val NOTEBOOK_DIRECTORY = "Notebook"
        private const val INDEX_DIRECTORY = ".granite"
        private const val INDEX_FILE = "notebook-index.json"
        private const val INDEX_SCHEMA_VERSION = 1
        private const val MAX_MARKDOWN_BYTES = 64L * 1024L * 1024L
        private const val MAX_RELATIVE_PATH_LENGTH = 4096
        private val NOTE_ID_NAMESPACE = UUID.fromString("2a2a6d4d-6234-4c5b-9e21-5f1c7f7f92d0")
        private val OPTIONAL_NOTE_METADATA = listOf(
            "tagIds",
            "bookId",
            "quote",
            "location",
            "attachments",
            "createdAt",
            "updatedAt",
            "conflictOf",
        )
    }
}
