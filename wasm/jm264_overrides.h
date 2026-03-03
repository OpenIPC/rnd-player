/**
 * Compile-time overrides for JM H.264 reference decoder WASM build.
 *
 * Included via `emcc -include jm264_overrides.h` to stub out file I/O
 * and other OS-dependent functions without modifying JM source files.
 */

#ifndef JM264_OVERRIDES_H
#define JM264_OVERRIDES_H

/* Suppress all file output — YUV, stats, trace */
#define TRACE 0
#define DUMP_DPB 0

/* Suppress snr.c / output.c file writes (if not already patched via sed) */
#define PAIR_FIELDS_IN_OUTPUT 0

/* JM's report.c tries to open/write stats files — stub the relevant calls.
 * These are called at the end of decoding; we never get there since we
 * control the decode loop from the wrapper. */
#define REPORT_ENABLED 0

#endif /* JM264_OVERRIDES_H */
