package com.granite.androidbridge

/** Validation shared by the native PDF range bridge and its JVM tests. */
internal object BookRangeRules {
    data class BoundedRange(
        val offset: Long,
        val length: Int,
    )

    fun validate(offset: Long, length: Long): BoundedRange {
        if (offset < 0) {
            throw BridgeFailure("Book range offset must not be negative")
        }
        if (length <= 0 || length > MAX_RANGE_BYTES) {
            throw BridgeFailure(
                "Book range length must be from 1 through $MAX_RANGE_BYTES bytes",
            )
        }
        return BoundedRange(offset = offset, length = length.toInt())
    }

    fun validateBounds(fileSize: Long, range: BoundedRange) {
        val end = try {
            Math.addExact(range.offset, range.length.toLong())
        } catch (_: ArithmeticException) {
            throw BridgeFailure("Book range offset and length overflow")
        }
        if (fileSize < 0 || end > fileSize) {
            throw BridgeFailure(
                "Book range ${range.offset}..$end exceeds file size $fileSize",
            )
        }
    }

    const val MAX_RANGE_BYTES: Long = 4L * 1024L * 1024L
}
