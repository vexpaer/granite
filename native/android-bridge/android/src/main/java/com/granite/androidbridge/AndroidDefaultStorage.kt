package com.granite.androidbridge

import android.content.Context
import androidx.documentfile.provider.DocumentFile
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.databind.JsonNode
import java.io.File
import java.util.UUID

/**
 * The one filesystem root the Android plugin accepts from the Rust host.
 *
 * Restricting filesystem operations to this exact app-private directory keeps
 * arbitrary Android paths out of the webview-facing host_call surface.
 */
internal class AndroidDefaultStorage(private val context: Context) {
    fun rootDirectory(): File {
        val directory = File(context.filesDir, ROOT_DIRECTORY_NAME)
        if (!directory.exists() && !directory.mkdirs()) {
            throw BridgeFailure("Android could not create the default Granite Library folder")
        }
        if (!directory.isDirectory) {
            throw BridgeFailure("The default Granite Library path is not a folder")
        }
        if (!directory.canRead() || !directory.canWrite()) {
            throw BridgeFailure("The default Granite Library folder is not readable and writable")
        }
        return directory.canonicalFile
    }

    fun rootDocument(): DocumentFile = DocumentFile.fromFile(rootDirectory())

    fun rootObject(): JSObject {
        val directory = rootDirectory()
        return JSObject(rootObject(directory).toString())
    }

    fun validateRoot(root: JsonNode): JSObject {
        val directory = requireRoot(root)
        val readable = directory.isDirectory && directory.canRead()
        val writable = readable && directory.canWrite()
        val result = JSObject(root.toString())
        result.put("path", directory.absolutePath)
        result.put(
            "permission",
            when {
                !readable -> "unavailable"
                !writable -> "readonly"
                else -> "granted"
            },
        )
        result.put("readonly", readable && !writable)
        result.put("scanState", if (readable) "idle" else "error")
        result.put("lastValidatedAt", BridgeClock.nowIso())
        return result
    }

    fun directoryFor(root: JsonNode): DocumentFile =
        DocumentFile.fromFile(requireRoot(root))

    fun isDefaultFilesystemRoot(root: JsonNode): Boolean =
        root.path("kind").asText() == "filesystem"

    fun requireRoot(root: JsonNode): File {
        val expected = rootDirectory()
        val rawPath = root.path("path").takeIf(JsonNode::isTextual)?.asText()
            ?: throw BridgeFailure("Default Granite Library root has no path")
        val supplied = try {
            File(rawPath).canonicalFile
        } catch (_: Exception) {
            throw BridgeFailure("Default Granite Library path is invalid")
        }
        if (supplied != expected) {
            throw BridgeFailure("Only Granite's app-private default library is available as a filesystem root")
        }
        return expected
    }

    private fun rootObject(directory: File): JSObject {
        val stableKey = "granite-default:${directory.absolutePath}"
        return JSObject()
            .put("id", UUID.nameUUIDFromBytes(stableKey.toByteArray(Charsets.UTF_8)).toString())
            .put("displayName", ROOT_DIRECTORY_NAME)
            .put("path", directory.absolutePath)
            .put("kind", "filesystem")
            .put("permission", "granted")
            .put("enabled", true)
            .put("isDefault", true)
            .put("readonly", false)
            .put("scanState", "idle")
            .put("lastValidatedAt", BridgeClock.nowIso())
    }

    companion object {
        const val ROOT_DIRECTORY_NAME = "Granite Library"
    }
}
