package com.granite.androidbridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BookRangeRulesTest {
    @Test
    fun acceptsTheInclusiveFourMiBBoundary() {
        assertEquals(
            BookRangeRules.BoundedRange(offset = 17, length = 4 * 1024 * 1024),
            BookRangeRules.validate(17, BookRangeRules.MAX_RANGE_BYTES),
        )
    }

    @Test
    fun rejectsNegativeOffsetsAndZeroOversizedOrNegativeLengths() {
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validate(-1, 1)
        }
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validate(0, 0)
        }
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validate(0, -1)
        }
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validate(0, BookRangeRules.MAX_RANGE_BYTES + 1)
        }
    }

    @Test
    fun boundsMustRemainInsideTheDocument() {
        val range = BookRangeRules.validate(8, 16)
        BookRangeRules.validateBounds(24, range)
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validateBounds(23, range)
        }
        assertThrows(BridgeFailure::class.java) {
            BookRangeRules.validateBounds(-1, range)
        }
    }
}
