package com.granite.androidbridge

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.databind.JsonNode
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.Locale
import java.util.UUID

/**
 * Rust-only local storage provider backed by a user-granted SAF tree.
 *
 * Provider keys already contain the dedicated profile prefix. This class uses
 * the complete key for traversal and uses the prefix only as a mandatory
 * containment boundary; it never prepends or rewrites the prefix.
 */
internal class SafProvider(private val context: Context) {
    private val resolver: ContentResolver = context.contentResolver

    fun request(request: ProviderRequest): JSObject {
        val profile = validateProfile(request.profile)
        val tree = providerRoot(profile)
        val method = request.method.trim().uppercase(Locale.ROOT)
        if (method.isEmpty() || method.length > 20 || method.any { !it.isLetter() }) {
            throw BridgeFailure("Invalid Provider method")
        }
        val headers = normalizeHeaders(request.headers)

        return when (method) {
            "LIST" -> list(tree, profile, request.key)
            "HEAD" -> head(tree, profile, request.key, headers)
            "GET" -> get(tree, profile, request.key, headers)
            "PUT" -> put(tree, profile, request.key, request.body, headers)
            "DELETE" -> delete(tree, profile, request.key, headers)
            else -> response(
                405,
                JSObject().put("Allow", "LIST, HEAD, GET, PUT, DELETE"),
            )
        }
    }

    private fun list(
        tree: DocumentFile,
        profile: ValidatedProfile,
        rawKey: String,
    ): JSObject {
        val key = validateKey(profile, rawKey, allowPrefixRoot = true, allowTrailingSlash = true)
        val records = mutableListOf<ListingRecord>()
        when (val target = findPath(tree, key.parts)) {
            null -> Unit
            else -> when {
                target.isFile -> {
                    records += listingRecord(target, key.parts)
                }
                target.isDirectory -> {
                    val pending = ArrayDeque<DirectoryNode>()
                    val visited = HashSet<String>()
                    pending.addLast(DirectoryNode(target, key.parts))
                    while (pending.isNotEmpty()) {
                        val (current, currentParts) = pending.removeFirst()
                        if (!visited.add(current.uri.toString())) continue
                        for (child in current.listFiles()) {
                            val name = child.name ?: continue
                            if (isInternalProviderFile(name)) continue
                            validateObjectName(name)
                            val childParts = currentParts + name
                            if (child.isDirectory) {
                                pending.addLast(DirectoryNode(child, childParts))
                                continue
                            }
                            if (!child.isFile || !child.exists()) continue
                            records += listingRecord(child, childParts)
                        }
                    }
                }
                else -> throw BridgeFailure(
                    "SAF Provider listing path is not a regular object or directory",
                )
            }
        }

        val json = JSONArray()
        for (record in records.sortedBy(ListingRecord::key)) {
            json.put(record.value)
        }
        val bytes = json.toString().toByteArray(Charsets.UTF_8)
        val responseHeaders = JSObject()
            .put("Content-Type", "application/json; charset=utf-8")
            .put("Content-Length", bytes.size.toString())
        return response(200, responseHeaders, bytes)
    }

    private fun listingRecord(file: DocumentFile, parts: List<String>): ListingRecord {
        val metadata = metadata(file)
        val listed = JSONObject()
            .put("key", parts.joinToString("/"))
            .put("size", metadata.size)
            .put("etag", quotedEtag(metadata.sha256))
        if (metadata.lastModified > 0) {
            listed.put("lastModified", BridgeClock.isoFromMillis(metadata.lastModified))
        }
        return ListingRecord(listed.getString("key"), listed)
    }

    private fun head(
        tree: DocumentFile,
        profile: ValidatedProfile,
        rawKey: String,
        headers: Map<String, String>,
    ): JSObject {
        val key = validateKey(profile, rawKey)
        val file = findPath(tree, key.parts)
            ?.takeIf { it.isFile && it.exists() }
            ?: return response(404)
        val metadata = metadata(file)
        return when (readPreconditionStatus(metadata, headers)) {
            304 -> response(304, validatorHeaders(metadata, includeLength = false))
            412 -> response(412, validatorHeaders(metadata, includeLength = false))
            else -> response(200, objectHeaders(metadata, includeLength = true))
        }
    }

    private fun get(
        tree: DocumentFile,
        profile: ValidatedProfile,
        rawKey: String,
        headers: Map<String, String>,
    ): JSObject {
        val key = validateKey(profile, rawKey)
        val file = findPath(tree, key.parts)
            ?.takeIf { it.isFile && it.exists() }
            ?: return response(404)
        val rangeHeader = header(headers, "range")
        val hasPreconditions =
            header(headers, "if-match") != null ||
                header(headers, "if-none-match") != null
        if (rangeHeader == null && !hasPreconditions) {
            val bytes = readDocument(file)
            return response(
                200,
                objectHeaders(metadata(file, bytes), includeLength = true),
                bytes,
            )
        }

        val metadata = metadata(file)
        when (readPreconditionStatus(metadata, headers)) {
            304 -> return response(304, validatorHeaders(metadata, includeLength = false))
            412 -> return response(412, validatorHeaders(metadata, includeLength = false))
        }
        if (rangeHeader == null) {
            val bytes = readDocument(file)
            if (
                bytes.size.toLong() != metadata.size ||
                sha256(bytes) != metadata.sha256
            ) {
                throw BridgeFailure("SAF Provider object changed during the read")
            }
            return response(200, objectHeaders(metadata, includeLength = true), bytes)
        }
        val range = parseRange(rangeHeader, metadata.size)
            ?: return response(
                416,
                validatorHeaders(metadata, includeLength = false)
                    .put("Content-Range", "bytes */${metadata.size}"),
            )
        val rangeLength = range.endInclusive - range.start + 1
        if (rangeLength > Int.MAX_VALUE) {
            return response(416, validatorHeaders(metadata, includeLength = false))
        }
        val body = UriRangeReader.read(
            context,
            file.uri,
            range.start,
            rangeLength.toInt(),
        )
        if (body.size.toLong() != rangeLength) {
            throw BridgeFailure("SAF Provider object changed during the ranged read")
        }
        return response(
            206,
            objectHeaders(metadata, includeLength = false)
                .put("Content-Length", body.size.toString())
                .put(
                    "Content-Range",
                    "bytes ${range.start}-${range.endInclusive}/${metadata.size}",
                ),
            body,
        )
    }

    private fun put(
        tree: DocumentFile,
        profile: ValidatedProfile,
        rawKey: String,
        bodyNode: JsonNode?,
        headers: Map<String, String>,
    ): JSObject {
        val key = validateKey(profile, rawKey)
        requireWritable(tree)
        val bytes = bodyBytes(bodyNode)
        val expectedHash = sha256(bytes)
        val declaredHash = header(headers, "x-granite-sha256")?.trim()?.takeIf(String::isNotEmpty)
        if (
            declaredHash != null &&
            (
                !SafProviderRules.isSha256Hex(declaredHash) ||
                    !declaredHash.equals(expectedHash, ignoreCase = true)
                )
        ) {
            return response(400)
        }

        val existing = findPath(tree, key.parts)
        if (existing != null && !existing.isFile) {
            return response(409)
        }
        val initialMetadata = existing
            ?.takeIf { it.exists() }
            ?.let(::metadata)
        writePreconditionStatus(initialMetadata, headers)?.let { status ->
            return response(
                status,
                initialMetadata?.let { validatorHeaders(it) } ?: JSObject(),
            )
        }

        val parentParts = key.parts.dropLast(1)
        val parent = ensureDirectoryPath(tree, parentParts)
        val filename = key.parts.last()
        val liveTarget = findExact(parent, filename)
        if (liveTarget != null && !liveTarget.isFile) {
            return response(409)
        }

        val temporaryFile = createUniqueFile(
            parent,
            TEMPORARY_PREFIX,
            ".bin",
            "application/octet-stream",
        )
        var temporary: DocumentFile? = temporaryFile
        var backup: DocumentFile? = null
        var finalDocument: DocumentFile? = null
        var originalRemoved = false
        var originalMetadata: ObjectMetadata? = null

        try {
            writeDocument(temporaryFile, bytes)
            val temporaryMetadata = metadata(temporaryFile, bytes)
            if (!sameContent(temporaryMetadata, expectedHash, bytes.size.toLong())) {
                throw BridgeFailure("SAF Provider temporary write verification failed")
            }

            // A second validation closes the gap between the preliminary HEAD
            // and replacement. SAF exposes no native compare-and-swap primitive,
            // so this is the strongest condition check available to the bridge.
            val current = findExact(parent, filename)
            if (current != null && !current.isFile) {
                temporaryFile.delete()
                temporary = null
                return response(409)
            }
            val currentMetadata = current
                ?.takeIf { it.exists() }
                ?.let(::metadata)
            writePreconditionStatus(currentMetadata, headers)?.let { status ->
                temporaryFile.delete()
                temporary = null
                return response(
                    status,
                    currentMetadata?.let { validatorHeaders(it) } ?: JSObject(),
                )
            }

            if (current != null) {
                originalMetadata = currentMetadata
                val createdBackup = createBackup(parent, filename, current)
                backup = createdBackup
                val backupMetadata = metadata(createdBackup)
                if (
                    currentMetadata == null ||
                    !sameContent(backupMetadata, currentMetadata.sha256, currentMetadata.size)
                ) {
                    throw BridgeFailure("SAF Provider safety backup verification failed")
                }
                val justBeforeDelete = metadata(current)
                if (
                    !sameContent(
                        justBeforeDelete,
                        currentMetadata.sha256,
                        currentMetadata.size,
                    )
                ) {
                    createdBackup.delete()
                    backup = null
                    temporaryFile.delete()
                    temporary = null
                    return response(412, validatorHeaders(justBeforeDelete))
                }
                if (!current.delete()) {
                    throw BridgeFailure("The SAF Provider does not allow safe replacement")
                }
                originalRemoved = true
            }

            val createdFinal = if (temporaryFile.renameTo(filename)) {
                temporary = null
                findExact(parent, filename)
                    ?: throw BridgeFailure("SAF Provider object disappeared after replacement")
            } else {
                val replacement = createFileExact(
                    parent,
                    filename,
                    "application/octet-stream",
                )
                val copied = copyDocument(temporaryFile, replacement)
                if (!sameContent(copied, expectedHash, bytes.size.toLong())) {
                    throw BridgeFailure("SAF Provider replacement write verification failed")
                }
                temporaryFile.delete()
                temporary = null
                replacement
            }
            finalDocument = createdFinal

            val finalMetadata = metadata(createdFinal)
            if (!sameContent(finalMetadata, expectedHash, bytes.size.toLong())) {
                throw BridgeFailure("SAF Provider final write verification failed")
            }
            backup?.delete()
            backup = null
            return response(
                if (initialMetadata == null) 201 else 200,
                objectHeaders(finalMetadata, includeLength = true),
            )
        } catch (failure: Exception) {
            var rollbackFailure: Exception? = null
            try {
                if (originalRemoved && backup != null) {
                    val restored = restoreBackup(
                        parent,
                        filename,
                        backup,
                        originalMetadata ?: metadata(backup),
                    )
                    backup = null
                    finalDocument = restored
                } else if (!originalRemoved) {
                    finalDocument
                        ?.takeIf { it.exists() && findExact(parent, filename)?.uri == it.uri }
                        ?.delete()
                }
            } catch (rollbackError: Exception) {
                rollbackFailure = rollbackError
            }
            temporary?.takeIf { it.exists() }?.delete()
            if (rollbackFailure == null) {
                backup?.takeIf { it.exists() }?.delete()
            }
            if (rollbackFailure != null) {
                throw BridgeFailure(
                    "SAF Provider write failed and rollback also failed: " +
                        (rollbackFailure.message ?: failure.message ?: "unknown error"),
                )
            }
            throw failure
        }
    }

    private fun delete(
        tree: DocumentFile,
        profile: ValidatedProfile,
        rawKey: String,
        headers: Map<String, String>,
    ): JSObject {
        val key = validateKey(profile, rawKey)
        requireWritable(tree)
        val file = findPath(tree, key.parts)
            ?.takeIf { it.isFile && it.exists() }
            ?: return response(404)
        val metadata = metadata(file)
        if (writePreconditionStatus(metadata, headers) != null) {
            return response(412, validatorHeaders(metadata))
        }
        val ifMatch = header(headers, "if-match")
        if (ifMatch != null) {
            val justBeforeDelete = metadata(file)
            if (
                !SafProviderRules.strongEtagMatches(
                    ifMatch,
                    justBeforeDelete.sha256,
                    exists = true,
                )
            ) {
                return response(412, validatorHeaders(justBeforeDelete))
            }
        }
        if (!file.delete()) {
            throw BridgeFailure("The SAF Provider did not delete the object")
        }
        return response(204)
    }

    private fun validateProfile(node: JsonNode?): ValidatedProfile {
        if (node == null || !node.isObject) {
            throw BridgeFailure("SAF Provider profile must be an object")
        }
        if (node.path("type").asText() != "local") {
            throw BridgeFailure("Android SAF Provider requires a local profile")
        }
        val credential = node.get("credentialId")
        if (credential == null || !credential.isTextual || credential.asText().isNotEmpty()) {
            throw BridgeFailure("Local SAF Provider credentialId must be empty")
        }
        val root = node.get("root")
        if (root == null || !root.isObject || root.path("kind").asText() != "saf") {
            throw BridgeFailure("Android local Provider requires a SAF root")
        }
        val endpoint = textualField(node, "endpoint")
        val rootPath = textualField(root, "path")
        if (endpoint != rootPath) {
            throw BridgeFailure("Local Provider endpoint must equal root.path")
        }
        val uri = try {
            Uri.parse(rootPath)
        } catch (_: Exception) {
            throw BridgeFailure("Invalid SAF Provider root URI")
        }
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) {
            throw BridgeFailure("Android SAF Provider root must use a content:// URI")
        }

        val prefixNode = node.get("prefix")
        if (prefixNode == null || !prefixNode.isTextual || prefixNode.asText().isBlank()) {
            throw BridgeFailure("Local SAF Provider requires a nonempty dedicated prefix")
        }
        val prefix = prefixNode.asText()
        val prefixParts = SafProviderRules.relativeParts(prefix, "Provider prefix")
        return ValidatedProfile(uri = uri, prefixParts = prefixParts)
    }

    private fun providerRoot(profile: ValidatedProfile): DocumentFile {
        val persisted = resolver.persistedUriPermissions.firstOrNull {
            it.uri == profile.uri && it.isReadPermission
        } ?: throw BridgeFailure("Persistent SAF Provider access is unavailable")
        if (!persisted.isReadPermission) {
            throw BridgeFailure("Read access to the SAF Provider is unavailable")
        }
        val tree = try {
            DocumentFile.fromTreeUri(context, profile.uri)
        } catch (_: Exception) {
            null
        } ?: throw BridgeFailure("SAF Provider root cannot be opened")
        if (!tree.exists() || !tree.isDirectory) {
            throw BridgeFailure("SAF Provider root is unavailable")
        }
        if (!tree.canRead()) {
            throw BridgeFailure("Read access to the SAF Provider root is unavailable")
        }
        return tree
    }

    private fun requireWritable(tree: DocumentFile) {
        val grant = resolver.persistedUriPermissions.firstOrNull { it.uri == tree.uri }
        if (grant == null || !grant.isWritePermission || !tree.canWrite()) {
            throw BridgeFailure("The SAF Provider root is read-only")
        }
    }

    private fun validateKey(
        profile: ValidatedProfile,
        rawKey: String,
        allowPrefixRoot: Boolean = false,
        allowTrailingSlash: Boolean = false,
    ): ValidatedKey {
        return ValidatedKey(
            SafProviderRules.validateKey(
                rawKey = rawKey,
                prefixParts = profile.prefixParts,
                allowPrefixRoot = allowPrefixRoot,
                allowTrailingSlash = allowTrailingSlash,
            ),
        )
    }

    private fun validateObjectName(name: String) {
        if (
            name.isEmpty() ||
            name == "." ||
            name == ".." ||
            name.contains('/') ||
            name.contains('\\') ||
            name.any { it.isISOControl() }
        ) {
            throw BridgeFailure("SAF Provider contains an unsupported object name")
        }
    }

    private fun textualField(node: JsonNode, field: String): String {
        val value = node.get(field)
        if (value == null || !value.isTextual || value.asText().isBlank()) {
            throw BridgeFailure("Missing required field: $field")
        }
        return value.asText()
    }

    private fun normalizeHeaders(node: JsonNode?): Map<String, String> {
        if (node == null || node.isNull) return emptyMap()
        if (!node.isObject || node.size() > MAX_HEADER_COUNT) {
            throw BridgeFailure("Provider headers must be a bounded object")
        }
        val headers = linkedMapOf<String, String>()
        val fields = node.fields()
        while (fields.hasNext()) {
            val (name, value) = fields.next()
            if (
                name.isBlank() ||
                name.length > MAX_HEADER_NAME_LENGTH ||
                name.any { it.isISOControl() } ||
                !value.isTextual ||
                value.asText().length > MAX_HEADER_VALUE_LENGTH ||
                value.asText().any { it.isISOControl() }
            ) {
                throw BridgeFailure("Provider headers contain an invalid value")
            }
            headers[name.lowercase(Locale.ROOT)] = value.asText()
        }
        return headers
    }

    private fun header(headers: Map<String, String>, name: String): String? {
        return headers[name.lowercase(Locale.ROOT)]
    }

    private fun bodyBytes(node: JsonNode?): ByteArray {
        if (node == null || node.isNull) return ByteArray(0)
        if (!node.isArray) {
            throw BridgeFailure("Provider body must be a byte array")
        }
        val bytes = ByteArray(node.size())
        for (index in 0 until node.size()) {
            val item = node[index]
            if (!item.isIntegralNumber) {
                throw BridgeFailure("Provider body contains a non-integer value")
            }
            val value = item.asInt()
            if (value !in 0..255) {
                throw BridgeFailure("Provider body value is outside 0..255")
            }
            bytes[index] = value.toByte()
        }
        return bytes
    }

    private fun findPath(tree: DocumentFile, parts: List<String>): DocumentFile? {
        var current: DocumentFile? = tree
        for (part in parts) {
            current = current?.findFile(part) ?: return null
            if (!current.exists()) return null
        }
        return current
    }

    private fun findExact(parent: DocumentFile, name: String): DocumentFile? {
        return parent.findFile(name)?.takeIf { it.name == name && it.exists() }
    }

    private fun ensureDirectoryPath(tree: DocumentFile, parts: List<String>): DocumentFile {
        var current = tree
        for (part in parts) {
            val existing = current.findFile(part)
            current = if (existing == null) {
                createDirectoryExact(current, part)
            } else {
                if (!existing.isDirectory) {
                    throw BridgeFailure("SAF Provider path component is not a directory")
                }
                existing
            }
        }
        return current
    }

    private fun createDirectoryExact(parent: DocumentFile, name: String): DocumentFile {
        validateObjectName(name)
        val created = parent.createDirectory(name)
            ?: throw BridgeFailure("The SAF Provider does not allow directory creation")
        if (created.name != name || !created.isDirectory) {
            created.delete()
            throw BridgeFailure("The SAF Provider changed the requested directory name")
        }
        return created
    }

    private fun createUniqueFile(
        parent: DocumentFile,
        prefix: String,
        suffix: String,
        mimeType: String,
    ): DocumentFile {
        repeat(MAX_UNIQUE_ATTEMPTS) {
            val candidate = "$prefix${UUID.randomUUID()}$suffix"
            if (parent.findFile(candidate) != null) return@repeat
            return createFileExact(parent, candidate, mimeType)
        }
        throw BridgeFailure("The SAF Provider could not allocate a temporary object")
    }

    private fun createFileExact(
        parent: DocumentFile,
        name: String,
        mimeType: String,
    ): DocumentFile {
        validateObjectName(name)
        val created = parent.createFile(mimeType, name)
            ?: throw BridgeFailure("The SAF Provider does not allow file creation")
        if (created.name != name || !created.isFile) {
            created.delete()
            throw BridgeFailure("The SAF Provider changed the requested object name")
        }
        return created
    }

    private fun createBackup(
        parent: DocumentFile,
        originalName: String,
        source: DocumentFile,
    ): DocumentFile {
        val backup = createUniqueFile(
            parent,
            BACKUP_PREFIX,
            ".bin",
            source.type ?: "application/octet-stream",
        )
        return try {
            val sourceMetadata = metadata(source)
            val copied = copyDocument(source, backup)
            if (!sameContent(copied, sourceMetadata.sha256, sourceMetadata.size)) {
                throw BridgeFailure("SAF Provider safety backup verification failed")
            }
            backup
        } catch (exception: Exception) {
            backup.delete()
            throw exception
        }
    }

    private fun restoreBackup(
        parent: DocumentFile,
        name: String,
        backup: DocumentFile,
        expected: ObjectMetadata?,
    ): DocumentFile {
        val failed = findExact(parent, name)
        if (failed != null && !failed.delete()) {
            throw BridgeFailure("SAF Provider rollback could not remove the failed object")
        }

        if (backup.renameTo(name)) {
            val restored = findExact(parent, name)
                ?: throw BridgeFailure("SAF Provider rollback object is missing")
            val restoredMetadata = metadata(restored)
            if (
                expected != null &&
                !sameContent(restoredMetadata, expected.sha256, expected.size)
            ) {
                throw BridgeFailure("SAF Provider rollback verification failed")
            }
            return restored
        }

        val restored = createFileExact(
            parent,
            name,
            backup.type ?: "application/octet-stream",
        )
        val copied = copyDocument(backup, restored)
        if (
            expected != null &&
            !sameContent(copied, expected.sha256, expected.size)
        ) {
            throw BridgeFailure("SAF Provider rollback copy verification failed")
        }
        backup.delete()
        return restored
    }

    private fun metadata(file: DocumentFile): ObjectMetadata {
        val input = context.openUriInputStream(file.uri)
            ?: throw BridgeFailure("Android could not read the SAF Provider object")
        return input.use { stream ->
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var size = 0L
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
                size += read
            }
            ObjectMetadata(
                sha256 = digest.digest().toHex(),
                size = size,
                lastModified = file.lastModified(),
            )
        }
    }

    private fun metadata(file: DocumentFile, bytes: ByteArray): ObjectMetadata {
        return ObjectMetadata(
            sha256 = sha256(bytes),
            size = bytes.size.toLong(),
            lastModified = file.lastModified(),
        )
    }

    private fun readDocument(file: DocumentFile): ByteArray {
        val input = context.openUriInputStream(file.uri)
            ?: throw BridgeFailure("Android could not read the SAF Provider object")
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        val maximum = minOf(
            Int.MAX_VALUE.toLong() - 8,
            Runtime.getRuntime().maxMemory() / 6,
        )
        input.use { stream ->
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                total += read
                if (total > maximum || total > MAX_PROVIDER_OBJECT_BYTES) {
                    throw BridgeFailure("SAF Provider object is too large for the bridge")
                }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun writeDocument(file: DocumentFile, bytes: ByteArray) {
        val output = context.openUriOutputStream(file.uri, "wt")
            ?: context.openUriOutputStream(file.uri, "w")
            ?: throw BridgeFailure("The SAF Provider does not allow writing")
        output.use { stream ->
            stream.write(bytes)
            stream.flush()
        }
    }

    private fun copyDocument(
        source: DocumentFile,
        destination: DocumentFile,
    ): ObjectMetadata {
        val input: InputStream = context.openUriInputStream(source.uri)
            ?: throw BridgeFailure("Android could not read the SAF Provider source")
        val output = context.openUriOutputStream(destination.uri, "wt")
            ?: context.openUriOutputStream(destination.uri, "w")
            ?: throw BridgeFailure("Android could not write the SAF Provider destination")
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
        return ObjectMetadata(
            sha256 = digest.digest().toHex(),
            size = size,
            lastModified = destination.lastModified(),
        )
    }

    private fun writePreconditionStatus(
        metadata: ObjectMetadata?,
        headers: Map<String, String>,
    ): Int? {
        return SafProviderRules.writePreconditionStatus(
            ifMatch = header(headers, "if-match"),
            ifNoneMatch = header(headers, "if-none-match"),
            currentEtag = metadata?.sha256,
            exists = metadata != null,
        )
    }

    private fun readPreconditionStatus(
        metadata: ObjectMetadata,
        headers: Map<String, String>,
    ): Int? {
        return SafProviderRules.readPreconditionStatus(
            ifMatch = header(headers, "if-match"),
            ifNoneMatch = header(headers, "if-none-match"),
            currentEtag = metadata.sha256,
        )
    }

    private fun parseRange(value: String, size: Long): ByteRange? {
        if (size <= 0 || !value.startsWith("bytes=", ignoreCase = true)) return null
        val specification = value.substringAfter('=').trim()
        if (specification.isEmpty() || specification.contains(',')) return null
        val separator = specification.indexOf('-')
        if (separator < 0 || specification.indexOf('-', separator + 1) >= 0) return null
        val startText = specification.substring(0, separator).trim()
        val endText = specification.substring(separator + 1).trim()

        if (startText.isEmpty()) {
            val suffixLength = endText.toLongOrNull() ?: return null
            if (suffixLength <= 0) return null
            val length = minOf(suffixLength, size)
            return ByteRange(size - length, size - 1)
        }

        val start = startText.toLongOrNull() ?: return null
        if (start < 0 || start >= size) return null
        val requestedEnd = if (endText.isEmpty()) size - 1 else endText.toLongOrNull() ?: return null
        if (requestedEnd < start) return null
        return ByteRange(start, minOf(requestedEnd, size - 1))
    }

    private fun objectHeaders(
        metadata: ObjectMetadata,
        includeLength: Boolean,
    ): JSObject {
        val headers = validatorHeaders(metadata, includeLength)
            .put("Content-Type", "application/octet-stream")
            .put("Accept-Ranges", "bytes")
        return headers
    }

    private fun validatorHeaders(
        metadata: ObjectMetadata,
        includeLength: Boolean = true,
    ): JSObject {
        val headers = JSObject()
            .put("ETag", quotedEtag(metadata.sha256))
            .put("x-granite-sha256", metadata.sha256)
        if (includeLength) headers.put("Content-Length", metadata.size.toString())
        if (metadata.lastModified > 0) {
            headers.put("Last-Modified", BridgeClock.isoFromMillis(metadata.lastModified))
        }
        return headers
    }

    private fun response(
        status: Int,
        headers: JSObject = JSObject(),
        body: ByteArray? = null,
    ): JSObject {
        val response = JSObject()
            .put("status", status)
            .put("headers", headers)
        if (body != null) response.put("body", bytesToJsArray(body))
        return response
    }

    private fun quotedEtag(hash: String): String = "\"$hash\""

    private fun sameContent(
        metadata: ObjectMetadata,
        expectedHash: String,
        expectedSize: Long,
    ): Boolean {
        return metadata.size == expectedSize &&
            metadata.sha256.equals(expectedHash, ignoreCase = true)
    }

    private fun isInternalProviderFile(name: String): Boolean {
        return name.startsWith(TEMPORARY_PREFIX) || name.startsWith(BACKUP_PREFIX)
    }

    private data class ValidatedProfile(
        val uri: Uri,
        val prefixParts: List<String>,
    )

    private data class ValidatedKey(val parts: List<String>)
    private data class DirectoryNode(val document: DocumentFile, val parts: List<String>)
    private data class ListingRecord(val key: String, val value: JSONObject)
    private data class ObjectMetadata(
        val sha256: String,
        val size: Long,
        val lastModified: Long,
    )

    private data class ByteRange(val start: Long, val endInclusive: Long)

    companion object {
        private const val MAX_HEADER_COUNT = 100
        private const val MAX_HEADER_NAME_LENGTH = 128
        private const val MAX_HEADER_VALUE_LENGTH = 8192
        private const val MAX_UNIQUE_ATTEMPTS = 16
        private const val MAX_PROVIDER_OBJECT_BYTES = 1L shl 30
        private const val TEMPORARY_PREFIX = ".granite-provider-tmp-"
        private const val BACKUP_PREFIX = ".granite-provider-backup-"
    }
}
