package com.granite.androidbridge

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResult
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@TauriPlugin
class AndroidBridgePlugin(private val activity: Activity) : Plugin(activity) {
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val jsonMapper = ObjectMapper()
    private val defaultStorage = AndroidDefaultStorage(activity.applicationContext)
    private val saf = SafFileSystem(activity.applicationContext)
    private val safProvider = SafProvider(activity.applicationContext)
    private val notebookMirror = NotebookSafMirror(activity.applicationContext, defaultStorage)
    private val credentials = KeystoreCredentialVault(activity.applicationContext)
    private val shareInbox = ShareInbox(activity.applicationContext)
    private val lifecycle = AndroidLifecycleController(activity)
    private val pendingPickedBooks = ConcurrentHashMap<String, Uri>()
    private var pendingExport: PendingExport? = null

    private var pendingBack: Invoke? = null
    private var queuedBack: BackEvent? = null
    private var backSequence = 0L
    private var pendingLifecycle: Invoke? = null
    private val lifecycleQueue = ArrayDeque<LifecycleEvent>()
    private var lifecycleSequence = 0L
    private var lastLifecycleState: String? = null
    private var pendingShare: Invoke? = null
    private val shareQueue = ArrayDeque<Int>()
    private val appCompatActivity = activity as AppCompatActivity

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (!lifecycle.backEnabled) {
                isEnabled = false
                appCompatActivity.onBackPressedDispatcher.onBackPressed()
                isEnabled = true
                return
            }

            backSequence++
            queuedBack = BackEvent(
                backSequence,
                BridgeClock.nowMillis(),
                SystemClock.elapsedRealtime(),
            )
            deliverBackIfPossible()
        }
    }

    init {
        appCompatActivity.onBackPressedDispatcher.addCallback(appCompatActivity, backCallback)
        lifecycle.restoreBackEnabled()
    }

    override fun load(webView: WebView) {
        enqueueLifecycle("foreground")
        captureShareIntent(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        captureShareIntent(intent)
    }

    override fun onResume(activity: AppCompatActivity) {
        lifecycle.onResume()
        if (lifecycleSequence == 0L) enqueueLifecycle("foreground")
    }

    override fun onPause(activity: AppCompatActivity) {
        enqueueLifecycle("background")
    }

    override fun onDestroy(activity: AppCompatActivity) {
        backCallback.remove()
        pendingBack?.reject("Android activity was destroyed")
        pendingBack = null
        pendingLifecycle?.reject("Android activity was destroyed")
        pendingLifecycle = null
        pendingShare?.reject("Android activity was destroyed")
        pendingShare = null
        pendingExport = null
        lifecycle.onDestroy()
        ioExecutor.shutdownNow()
    }

    @Command
    fun hostCall(invoke: Invoke) {
        val request = try {
            invoke.parseArgs(HostCallRequest::class.java)
        } catch (exception: Exception) {
            invoke.reject("Invalid Android bridge request")
            return
        }

        when (request.op) {
            "root.pick" -> activity.runOnUiThread { pickRoot(invoke) }
            "file.pickBooks" -> activity.runOnUiThread { pickBooks(invoke) }
            "book.export", "backup.export" ->
                activity.runOnUiThread { exportFile(invoke, request.args) }
            "lifecycle.keepAwake" -> {
                val enabled = requiredBoolean(request.args, "enabled")
                activity.runOnUiThread {
                    invoke.resolveObject(lifecycle.setKeepAwake(enabled))
                }
            }
            "lifecycle.immersive" -> {
                val enabled = requiredBoolean(request.args, "enabled")
                activity.runOnUiThread {
                    invoke.resolveObject(lifecycle.setImmersive(enabled))
                }
            }
            "lifecycle.back" -> {
                val enabled = requiredBoolean(request.args, "enabled")
                activity.runOnUiThread {
                    invoke.resolveObject(lifecycle.setBackEnabled(enabled))
                }
            }
            "root.default",
            "root.scan",
            "root.validate",
            "root.migrate",
            "book.import",
            "book.read",
            "book.stat",
            "book.readRange",
            "book.write",
            "book.locate",
            "book.trash",
            "credential.set",
            "credential.delete",
            "file.readPickedBook",
            "file.releasePickedBooks",
            "share.consume",
            "share.read",
            "share.ack",
            "diagnostics",
            -> executeIo(invoke, request.op, request.args)
            "root.migrateCancel" -> {
                saf.cancelMigration()
                activity.runOnUiThread { invoke.resolveObject(true) }
            }
            "state.load",
            "state.save",
            "provider.request",
            -> invoke.reject("This operation is owned by the Rust host")
            "credential.get", "credential.resolve" ->
                invoke.reject("Credential resolution is unavailable to the webview")
            "notebook.mirror", "notebook.sync" ->
                invoke.reject("Notebook mirroring is available only to the Rust host")
            else -> invoke.reject("Unknown Android bridge operation")
        }
    }

    /**
     * Long-poll entry used only by the Rust plugin handle. The returned event is
     * emitted by the Rust plugin as `granite://android-back`.
     */
    @Command
    fun awaitBack(invoke: Invoke) {
        activity.runOnUiThread {
            if (pendingBack != null) {
                invoke.reject("An Android back listener is already active")
                return@runOnUiThread
            }
            pendingBack = invoke
            deliverBackIfPossible()
        }
    }

    @Command
    fun awaitLifecycle(invoke: Invoke) {
        activity.runOnUiThread {
            if (pendingLifecycle != null) {
                invoke.reject("An Android lifecycle listener is already active")
                return@runOnUiThread
            }
            pendingLifecycle = invoke
            deliverLifecycleIfPossible()
        }
    }

    @Command
    fun awaitShare(invoke: Invoke) {
        activity.runOnUiThread {
            if (pendingShare != null) {
                invoke.reject("An Android share listener is already active")
                return@runOnUiThread
            }
            pendingShare = invoke
            deliverShareIfPossible()
        }
    }

    /** Rust-only credential access for provider signing. */
    @Command
    fun resolveCredential(invoke: Invoke) {
        val request = try {
            invoke.parseArgs(CredentialRequest::class.java)
        } catch (_: Exception) {
            invoke.reject("Invalid credential request")
            return
        }
        ioExecutor.execute {
            try {
                val secret = credentials.resolve(request.id)
                activity.runOnUiThread {
                    invoke.resolve(JSObject().put("secret", secret))
                }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Credential is unavailable")
            }
        }
    }

    /** Rust-only local Provider transport backed by one selected SAF tree. */
    @Command
    fun providerRequest(invoke: Invoke) {
        val request = try {
            invoke.parseArgs(ProviderRequest::class.java)
        } catch (_: Exception) {
            invoke.reject("Invalid Android Provider request")
            return
        }
        ioExecutor.execute {
            try {
                val result = safProvider.request(request)
                activity.runOnUiThread { invoke.resolveObject(result) }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Android SAF Provider request failed")
            }
        }
    }

    /** Rust-only Notebook mirroring through the selected SAF root. */
    @Command
    fun mirrorNotebook(invoke: Invoke) {
        val state = parseNotebookState(invoke) ?: return
        ioExecutor.execute {
            try {
                val result = notebookMirror.mirror(state)
                activity.runOnUiThread { invoke.resolveObject(result) }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Android Notebook mirroring failed")
            }
        }
    }

    /** Rust-only Notebook read-back through the selected SAF root. */
    @Command
    fun syncNotebook(invoke: Invoke) {
        val state = parseNotebookState(invoke) ?: return
        ioExecutor.execute {
            try {
                val result = notebookMirror.sync(state)
                activity.runOnUiThread { invoke.resolveObject(result) }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Android Notebook synchronization failed")
            }
        }
    }

    @ActivityCallback
    fun rootPickerResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve()
            return
        }
        val intent = result.data
        val uri = intent?.data
        if (uri == null) {
            invoke.reject("Android returned no folder")
            return
        }

        try {
        val takeFlags = intent.flags
                .and(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            if (takeFlags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) {
                throw BridgeFailure("Android did not grant read access")
            }
            activity.contentResolver.takePersistableUriPermission(uri, takeFlags)
            invoke.resolve(saf.pickRootResult(uri))
        } catch (exception: Exception) {
            rejectSafely(invoke, exception, "The selected library folder could not be authorized")
        }
    }

    @ActivityCallback
    fun bookPickerResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolveObject(JSArray())
            return
        }
        val uris = resultUris(result.data)
        ioExecutor.execute {
            val createdIds = mutableListOf<String>()
            try {
                val books = JSArray()
                for (uri in uris) {
                    val name = saf.displayName(uri) ?: uri.lastPathSegment ?: "imported-book"
                    if (bookExtension(name) == null) continue
                    val id = UUID.randomUUID().toString()
                    pendingPickedBooks[id] = uri
                    createdIds += id
                    books.put(
                        JSObject()
                            .put("id", id)
                            .put("name", name)
                            .put("size", saf.sizeUri(uri)),
                    )
                }
                activity.runOnUiThread { invoke.resolveObject(books) }
            } catch (exception: Exception) {
                createdIds.forEach { pendingPickedBooks.remove(it) }
                rejectSafely(invoke, exception, "The selected books could not be prepared")
            }
        }
    }

    @ActivityCallback
    fun exportResult(invoke: Invoke, result: ActivityResult) {
        val export = pendingExport
        pendingExport = null
        if (result.resultCode != Activity.RESULT_OK || export == null) {
            invoke.resolveObject(false)
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            invoke.resolveObject(false)
            return
        }
        ioExecutor.execute {
            try {
                saf.writeExport(uri, export.bytes)
                activity.runOnUiThread { invoke.resolveObject(true) }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Export failed")
            }
        }
    }

    private fun pickRoot(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        try {
            startActivityForResult(invoke, intent, "rootPickerResult")
        } catch (exception: Exception) {
            rejectSafely(invoke, exception, "No Android folder picker is available")
        }
    }

    private fun pickBooks(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_MIME_TYPES, SUPPORTED_MIME_TYPES)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            startActivityForResult(invoke, intent, "bookPickerResult")
        } catch (exception: Exception) {
            rejectSafely(invoke, exception, "No Android document picker is available")
        }
    }

    private fun exportFile(invoke: Invoke, args: JsonNode) {
        if (pendingExport != null) {
            invoke.reject("An Android export dialog is already open")
            return
        }
        val filename = requiredString(args, "filename")
        val bytes = bytesFromNode(args, "bytes")
        pendingExport = PendingExport(bytes)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeTypeForName(filename)
            putExtra(Intent.EXTRA_TITLE, filename)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        try {
            startActivityForResult(invoke, intent, "exportResult")
        } catch (exception: Exception) {
            pendingExport = null
            rejectSafely(invoke, exception, "No Android save dialog is available")
        }
    }

    private fun executeIo(invoke: Invoke, op: String, args: JsonNode) {
        ioExecutor.execute {
            try {
                val result = dispatchIo(op, args)
                activity.runOnUiThread { invoke.resolveObject(result) }
            } catch (exception: Exception) {
                rejectSafely(invoke, exception, "Android bridge operation failed")
            }
        }
    }

    private fun dispatchIo(op: String, args: JsonNode): Any {
        return when (op) {
            "root.default" -> defaultStorage.rootObject()
            "root.scan" -> saf.scan(requiredRoot(args))
            "root.validate" -> saf.validateRoot(requiredRoot(args))
            "root.migrate" -> {
                val from = args.get("from")
                    ?: throw BridgeFailure("Missing source library root")
                val to = args.get("to")
                    ?: throw BridgeFailure("Missing destination library root")
                saf.migrate(from, to)
            }
            "file.readPickedBook" -> {
                val id = requiredString(args, "id")
                val uri = pendingPickedBooks[id]
                    ?: throw BridgeFailure("The selected book handle has expired")
                try {
                    val (name, bytes) = saf.readUri(uri)
                    JSObject()
                        .put("name", name)
                        .put("bytes", bytesToJsArray(bytes))
                } finally {
                    pendingPickedBooks.remove(id)
                }
            }
            "file.releasePickedBooks" -> {
                requiredStringSet(args, "ids").forEach { pendingPickedBooks.remove(it) }
                true
            }
            "book.import" -> {
                val imported = saf.importBook(
                    requiredRoot(args),
                    requiredString(args, "filename"),
                    bytesFromNode(args, "bytes"),
                )
                JSObject()
                    .put("relativePath", imported.relativePath)
                    .put("sha256", imported.sha256)
                    .put("size", imported.size)
            }
            "book.read" -> bytesToJsArray(
                saf.readBook(
                    requiredRoot(args),
                    requiredString(args, "relativePath"),
                ),
            )
            "book.stat" -> saf.statBook(
                requiredRoot(args),
                requiredString(args, "relativePath"),
            )
            "book.readRange" -> bytesToJsArray(
                saf.readBookRange(
                    requiredRoot(args),
                    requiredString(args, "relativePath"),
                    requiredLong(args, "offset"),
                    requiredLong(args, "length"),
                ),
            )
            "book.write" -> {
                val request = try {
                    jsonMapper.treeToValue(args, WriteBookArgs::class.java)
                } catch (exception: Exception) {
                    throw BridgeFailure(
                        "Invalid book.write request: " +
                            (exception.message ?: "arguments do not match the contract"),
                    )
                }
                saf.writeBook(
                    request.root,
                    request.relativePath,
                    bytesFromJson(request.bytes, "bytes"),
                    request.expectedSha256,
                )
            }
            "book.locate" -> saf.locateBook(
                requiredRoot(args),
                requiredString(args, "relativePath"),
            )
            "book.trash" -> saf.trashBook(
                requiredRoot(args),
                requiredString(args, "relativePath"),
                requiredString(args, "bookId"),
            )
            "credential.set" -> {
                val id = requiredString(args, "id")
                val secret = allowBlankString(args, "secret")
                credentials.set(id, secret)
                true
            }
            "credential.delete" -> credentials.delete(requiredString(args, "id"))
            "share.consume" -> shareInbox.consume()
            "share.read" -> shareInbox.read(requiredString(args, "id"))
            "share.ack" -> {
                val ids = requiredStringSet(args, "ids")
                JSObject().put("acknowledged", shareInbox.acknowledge(ids))
            }
            "diagnostics" -> diagnostics()
            else -> throw BridgeFailure("Unsupported Android operation")
        }
    }

    private fun diagnostics(): JSObject {
        val packageInfo = activity.packageManager.getPackageInfo(activity.packageName, 0)
        val version = if (Build.VERSION.SDK_INT >= 28) {
            packageInfo.longVersionCode.toString()
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toString()
        }
        return JSObject()
            .put("platform", "android")
            .put("apiLevel", Build.VERSION.SDK_INT)
            .put("runtime", "WebView")
            .put("appVersion", packageInfo.versionName ?: version)
    }

    private fun captureShareIntent(intent: Intent?) {
        if (intent == null) return
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) {
            return
        }
        ioExecutor.execute {
            try {
                val count = shareInbox.captureIntent(intent)
                if (count > 0) {
                    activity.runOnUiThread {
                        shareQueue.addLast(count)
                        deliverShareIfPossible()
                        trigger("share-import", JSObject().put("count", count))
                    }
                }
            } catch (_: Exception) {
                // The provider grant can expire before a cold start finishes.
                // The Rust host can surface share.consume failures to the user.
            }
        }
    }

    private fun resultUris(intent: Intent?): List<Uri> {
        if (intent == null) return emptyList()
        val uris = linkedSetOf<Uri>()
        intent.clipData?.let { clipData: ClipData ->
            for (index in 0 until clipData.itemCount) {
                clipData.getItemAt(index).uri?.let(uris::add)
            }
        }
        intent.data?.let(uris::add)
        return uris.toList()
    }

    private fun deliverBackIfPossible() {
        val event = queuedBack ?: return
        val invoke = pendingBack ?: return
        queuedBack = null
        pendingBack = null
        invoke.resolve(
            JSObject()
                .put("sequence", event.sequence)
                .put("pressedAtMs", event.pressedAtMs)
                .put("elapsedRealtimeMs", event.elapsedRealtimeMs),
        )
    }

    private fun enqueueLifecycle(state: String) {
        if (lastLifecycleState == state) return
        lastLifecycleState = state
        lifecycleSequence++
        lifecycleQueue.addLast(
            LifecycleEvent(
                sequence = lifecycleSequence,
                state = state,
                occurredAtMs = BridgeClock.nowMillis(),
                elapsedRealtimeMs = SystemClock.elapsedRealtime(),
            ),
        )
        deliverLifecycleIfPossible()
    }

    private fun deliverLifecycleIfPossible() {
        val invoke = pendingLifecycle ?: return
        val event = lifecycleQueue.pollFirst() ?: return
        pendingLifecycle = null
        invoke.resolve(
            JSObject()
                .put("sequence", event.sequence)
                .put("state", event.state)
                .put("occurredAtMs", event.occurredAtMs)
                .put("elapsedRealtimeMs", event.elapsedRealtimeMs),
        )
    }

    private fun deliverShareIfPossible() {
        val invoke = pendingShare ?: return
        val count = shareQueue.pollFirst() ?: return
        pendingShare = null
        invoke.resolve(JSObject().put("count", count))
    }

    private fun rejectSafely(invoke: Invoke, exception: Exception, fallback: String) {
        val message = exception.message?.takeIf { it.isNotBlank() } ?: fallback
        activity.runOnUiThread { invoke.reject(message) }
    }

    private fun allowBlankString(node: JsonNode, field: String): String {
        val value = node.get(field)
        if (value == null || value.isNull || !value.isTextual) {
            throw BridgeFailure("Missing required field: $field")
        }
        return value.asText()
    }

    private fun requiredStringSet(node: JsonNode, field: String): Set<String> {
        val value = node.get(field)
            ?: throw BridgeFailure("Missing required field: $field")
        if (!value.isArray) {
            throw BridgeFailure("Field $field must be a string array")
        }
        if (value.size() > 500) {
            throw BridgeFailure("Field $field accepts at most 500 entries")
        }
        val output = linkedSetOf<String>()
        for (item in value) {
            if (!item.isTextual || item.asText().isBlank()) {
                throw BridgeFailure("Field $field contains an invalid id")
            }
            output += item.asText()
        }
        return output
    }

    private fun parseNotebookState(invoke: Invoke): JsonNode? {
        return try {
            val request = invoke.parseArgs(NotebookStateRequest::class.java)
            if (!request.state.isObject) {
                invoke.reject("Notebook state must be an AppData object")
                null
            } else {
                request.state
            }
        } catch (_: Exception) {
            invoke.reject("Invalid Notebook state request")
            null
        }
    }

    private fun bookExtension(name: String): String? {
        return name.substringAfterLast('.', "").lowercase()
            .takeIf { it in setOf("epub", "pdf", "txt", "mobi") }
    }

    private fun mimeTypeForName(name: String): String {
        return when (bookExtension(name)) {
            "epub" -> "application/epub+zip"
            "pdf" -> "application/pdf"
            "txt" -> "text/plain"
            "mobi" -> "application/x-mobipocket-ebook"
            else -> MimeTypeMap.getSingleton()
                .getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
                ?: "application/octet-stream"
        }
    }

    private data class PendingExport(val bytes: ByteArray)

    private data class BackEvent(
        val sequence: Long,
        val pressedAtMs: Long,
        val elapsedRealtimeMs: Long,
    )

    private data class LifecycleEvent(
        val sequence: Long,
        val state: String,
        val occurredAtMs: Long,
        val elapsedRealtimeMs: Long,
    )

    companion object {
        private val SUPPORTED_MIME_TYPES = arrayOf(
            "application/epub+zip",
            "application/pdf",
            "text/plain",
            "application/x-mobipocket-ebook",
            "application/octet-stream",
        )
    }
}
