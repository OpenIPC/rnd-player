/**
 * Compile-time overrides for HM H.265 reference decoder WASM build.
 *
 * Included via `em++ -include hm265_overrides.h` to disable debug/trace
 * features and OS-dependent functions without modifying HM source files.
 */

#ifndef HM265_OVERRIDES_H
#define HM265_OVERRIDES_H

/* Disable decoder debug bit statistics (requires compile-time counters) */
#define RExt__DECODER_DEBUG_BIT_STATISTICS 0

/* Disable decoder debug tool statistics */
#define RExt__DECODER_DEBUG_TOOL_STATISTICS 0

/* Disable tracing (would require file I/O for trace output) */
#ifdef ENC_DEC_TRACE
#undef ENC_DEC_TRACE
#endif

/* Disable high-bit-depth profiling if enabled */
#ifdef RExt__HIGH_BIT_DEPTH_SUPPORT
#undef RExt__HIGH_BIT_DEPTH_SUPPORT
#define RExt__HIGH_BIT_DEPTH_SUPPORT 0
#endif

#endif /* HM265_OVERRIDES_H */
