# DRM User Guide

This guide explains how DRM (Digital Rights Management) works in R&D Player, from basic concepts through daily use to advanced troubleshooting. It is written for QA engineers, media engineers, and anyone who works with encrypted video streams.

---

## 1. What is DRM?

### Why Video Needs Protection

DRM prevents unauthorized copying and redistribution of video content. Without DRM, anyone could download a video file and share it freely. DRM encrypts the video so that only authorized viewers with a valid license can watch it.

### How Encrypted Video Works

All major DRM systems use **CENC** (Common Encryption). The idea is simple:

1. The video is encrypted once using standard AES encryption
2. Different DRM systems can each provide the decryption key in their own way
3. The browser's CDM (Content Decryption Module) handles the actual decryption

This means the same encrypted file works with Widevine on Chrome, FairPlay on Safari, and PlayReady on Edge — each DRM system just delivers the key differently.

### Key Concepts

| Term | What It Means |
|------|---------------|
| **KID** (Key ID) | A unique identifier for each encryption key, stored in the video file and manifest. The player uses it to request the right key. |
| **CEK** (Content Encryption Key) | The actual AES key that encrypts/decrypts the video data. Never exposed to users directly. |
| **PSSH** (Protection System Specific Header) | A data blob in the manifest or init segment that tells the DRM system how to request a license. Each DRM system has its own PSSH format. |
| **EME** (Encrypted Media Extensions) | A browser API that connects the video player to the DRM system. The player calls EME, EME talks to the CDM. |
| **CDM** (Content Decryption Module) | The browser component that actually decrypts video. Chrome has Widevine CDM built in, Safari has FairPlay, Edge has PlayReady. |
| **License** | A message from the license server containing the decryption key(s), wrapped so only the authorized CDM can use them. |
| **Init segment** | The first bytes of a video stream containing codec configuration and encryption metadata (tenc box with KID, scheme, IV size). |

### DRM Systems in the Wild

| System | Browser / Platform | Key System Identifier |
|--------|-------------------|----------------------|
| **Widevine** | Chrome, Firefox, Android, ChromeOS | `com.widevine.alpha` |
| **FairPlay** | Safari (macOS, iOS) | `com.apple.fps` / `com.apple.fps.1_0` |
| **PlayReady** | Edge (Windows), Xbox | `com.microsoft.playready` |
| **ClearKey** | All browsers (no hardware protection) | `org.w3.clearkey` |

ClearKey is a special case — it is part of the EME standard and uses no hardware protection. The key is delivered in the clear (hence the name). It provides encryption but not strong DRM, making it suitable for testing and low-security scenarios.

---

## 2. How This Player Handles DRM

### Overview

When you load an encrypted stream, the player automatically:

1. Parses the manifest to detect DRM signaling (ContentProtection elements in DASH, EXT-X-KEY tags in HLS)
2. Determines which DRM system to use based on what the browser supports and what the manifest declares
3. Configures the appropriate license acquisition flow
4. Begins playback once keys are obtained

Most of this happens invisibly. You only need to provide the right URL parameters.

### Three Ways to Provide Keys

#### a. Direct ClearKey via URL parameter

The simplest method. Provide the hex-encoded key directly in the URL:

```
?v=https://cdn.example.com/stream/manifest.mpd&key=abcdef0123456789abcdef0123456789
```

The player parses the `key` parameter and configures ClearKey EME with it. No license server involved.

#### b. License server via URL parameters

For server-based key delivery (ClearKey, Widevine, or FairPlay — auto-detected):

```
?v=https://cdn.example.com/stream/manifest.mpd&license=https://drm.example.com/license&token=eyJhbGci...&asset=movie-123
```

The player contacts the license server with the session token and asset ID. The server authenticates the request and returns the appropriate keys.

#### c. Manual key entry

If you load an encrypted stream without providing `key` or `license` parameters, the player will detect the encryption and prompt you to enter a key manually.

### URL Parameter Reference

| Parameter | Description | Example |
|-----------|-------------|---------|
| `v` | Stream URL (DASH manifest or HLS playlist) | `https://cdn.example.com/manifest.mpd` |
| `key` | Hex-encoded ClearKey (32 hex characters = 16 bytes) | `abcdef0123456789abcdef0123456789` |
| `license` | License server base URL | `https://drm.example.com/license` |
| `token` | Session/authentication token (usually a JWT) | `eyJhbGci...` |
| `asset` | Asset identifier for the license server | `movie-123` |

### Automatic DRM Detection Flow

```
Load manifest
    |
    v
Detect ContentProtection / EXT-X-KEY
    |
    +-- Widevine PSSH found + license URL?
    |       --> Configure Widevine proxy (/license/widevine)
    |
    +-- FairPlay HLS key (com.apple.streamingkeydelivery)?
    |       --> Set up FairPlay via WebKit EME (/license/fairplay)
    |
    +-- ClearKey (key param or license server)?
    |       --> Fetch license, configure ClearKey EME
    |
    +-- No DRM detected
            --> Play unencrypted
```

When using the license server (`license` + `token` + `asset` params), the player auto-detects the appropriate DRM path:

- On Chrome/Firefox: if the manifest contains a Widevine ContentProtection entry, the player uses the Widevine proxy path
- On Safari: if HLS keys use the FairPlay key format, the player uses the FairPlay path (legacy WebKit EME API)
- Fallback: ClearKey path via the base license URL

### Software Decryption Fallback

Some browsers report ClearKey EME as supported but silently fail to decrypt (notably Playwright's WebKit engine). The player handles this with a three-stage fallback:

1. **Pre-check**: Probe `requestMediaKeySystemAccess("org.w3.clearkey", ...)` — if rejected, go straight to software decryption
2. **Try EME**: Load with ClearKey EME and wait up to 1.5 seconds
3. **Post-check**: If `readyState` stays at 1 (HAVE_METADATA) despite buffered data, EME silently failed — reload with software decryption

Software decryption uses the Web Crypto API (AES-128-CTR) to decrypt segments in JavaScript before they reach the browser's media decoder. It strips ContentProtection from the manifest, rewrites encrypted codec boxes (encv to avc1), and decrypts each sample's mdat in-place.

Software decryption only supports the `cenc` encryption scheme (AES-CTR). Content using `cbcs` (AES-CBC with pattern encryption, common on Apple platforms) is not supported in software mode.

### Browser Compatibility Matrix

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| Widevine | Yes | Yes | No | Yes (Chromium) |
| FairPlay | No | No | Yes | No |
| PlayReady | No | No | No | Yes (Windows) |
| ClearKey EME | Yes | Yes | Partial* | Yes |
| Software decrypt | Yes | Yes | Yes | Yes |
| EME API | Yes | Yes | Yes | Yes |

\* Safari's ClearKey EME may silently fail on some configurations. The software decryption fallback handles this automatically.

---

## 3. Playing Protected Content

### Step by Step: Loading an Encrypted Stream

1. **Enter the stream URL** in the player's URL field, or provide it via the `v` parameter
2. **Add DRM parameters** as needed:
   - For direct ClearKey: append `&key=<hex>`
   - For license server: append `&license=<url>&token=<jwt>&asset=<id>`
3. **Click Play** — the player detects encryption, acquires keys, and begins playback
4. **Check the diagnostics badge** (orange circle on the right-click menu) if something goes wrong

### Example URLs

**ClearKey with direct key:**
```
?v=https://cdn.example.com/encrypted/manifest.mpd&key=000102030405060708090a0b0c0d0e0f
```

**License server (auto-detects Widevine/FairPlay/ClearKey):**
```
?v=https://cdn.example.com/encrypted/manifest.mpd&license=https://drm.example.com/license&token=eyJhbGciOiJIUzI1NiJ9.test&asset=content-42
```

**Encrypted HLS on Safari (FairPlay auto-detected):**
```
?v=https://cdn.example.com/encrypted/master.m3u8&license=https://drm.example.com/license&token=eyJ...&asset=content-42
```

### What DRM Error Messages Mean

| Message | Meaning | First Step |
|---------|---------|------------|
| "Unable to decrypt" | The key provided doesn't match the content's KID | Check the `key` parameter or license server response |
| "License server returned HTTP 4xx" | Authentication or entitlement failure | Verify the `token` is valid and not expired |
| "License server returned HTTP 5xx" | Server-side error | Check license server logs |
| "License server returned no keys" | Server responded but with empty key list | Check asset ID and entitlements |
| "EME API not available" | Browser doesn't support EME | Use HTTPS, try a different browser |
| "Not a secure context" | Page is loaded over HTTP | Switch to HTTPS (EME requires it) |
| "FairPlay not supported" | Not running in Safari or WebKitMediaKeys unavailable | Use Safari for FairPlay content |

---

## 4. DRM Diagnostics Panel

The diagnostics panel provides deep visibility into the DRM pipeline — what the manifest declares, what the browser negotiated, and what went wrong.

### Opening the Panel

- **Keyboard shortcut**: Press **D**
- **Right-click menu**: Right-click the video and select "DRM Diagnostics"

The panel opens as an overlay on the right side of the player.

### Tab Guide

The panel has five tabs: **Metadata**, **Timeline**, **License**, **Diagnostics**, and **Compat**.

#### Metadata Tab

Shows all DRM information extracted from the manifest and init segment, grouped by DRM system.

**What each field means:**

| Field | Description |
|-------|-------------|
| Scheme URI | The DRM system identifier from ContentProtection (e.g., `urn:uuid:edef8ba9-...` for Widevine) |
| Default KID | The Key ID declared in the manifest — identifies which key to request |
| Robustness | The required security level (e.g., `HW_SECURE_ALL` for hardware DRM) |
| License URL | License server URL declared in the manifest (if any) |
| PSSH | Base64-encoded Protection System Specific Header |
| Track N | Per-track encryption info from the init segment's tenc box |
| KID (track) | Key ID from the init segment — should match the manifest KID |
| IV size | Initialization vector size (8 or 16 bytes) |
| Constant IV | Fixed IV used for all samples (if present, common in cbcs) |

For PSSH boxes, the panel decodes system-specific data:

- **Widevine**: algorithm, key IDs, provider, content ID, policy, protection scheme
- **PlayReady**: KID, license acquisition URL, license UI URL, custom attributes

#### Timeline Tab

A chronological log of all EME (Encrypted Media Extensions) events, showing the full lifecycle of key acquisition.

Each event shows:
- **Timestamp**: Relative time from the first event (MM:SS.mmm)
- **Type badge**: Color-coded event type (green = success, red = error, amber = warning)
- **Detail**: Human-readable description of what happened
- **Latency**: Time taken for the operation (where applicable)

Click any event to expand its data payload.

**EME event types:**

| Badge | Type | Meaning |
|-------|------|---------|
| ACCESS? | access-request | Player is probing for DRM system support |
| ACCESS ✓ | access-granted | Browser confirmed DRM system is available |
| ACCESS ✗ | access-denied | Browser rejected the DRM system |
| KEYS | keys-created | MediaKeys object was created |
| SET | keys-set | MediaKeys attached to the video element |
| INIT | generate-request | License request initiated (challenge generated) |
| MSG | message | CDM generated a license challenge message |
| UPDATE | update | License response was applied to the session |
| STATUS | key-status-change | Key status changed (usable, expired, etc.) |
| CLOSE | close | Key session was closed |
| EXPIRY | expiration-change | License expiration time changed |
| ERROR | error | An error occurred in the EME pipeline |

A typical healthy sequence looks like:
ACCESS? → ACCESS ✓ → KEYS → SET → INIT → MSG → UPDATE → STATUS

#### License Tab

Shows every license exchange between the player and the license server. Each exchange is color-coded by DRM system (green = ClearKey, blue = Widevine, purple = FairPlay).

Click an exchange to expand details:
- **Request headers**: Sent headers (Authorization tokens are masked for security)
- **Request body**: The license request payload (sensitive fields masked)
- **Response body**: The server's response (keys and tokens masked)
- **Decoded license**: Parsed fields including session ID, key count, transport encryption method, policy (expiry, renewal interval, max resolution), and watermark status
- **Error**: Error message if the exchange failed

#### Diagnostics Tab

Runs 12 automated checks (SF-001 through SF-012) that detect silent DRM failures — problems where playback fails without a clear error message.

If no issues are found, the tab shows "No issues detected" with a green checkmark. Otherwise, issues are listed by severity (errors first, then warnings).

Click any diagnostic to expand its detailed explanation and recommended action.

**All 12 silent failure checks:**

| ID | Severity | Title | What It Means | Recommended Action |
|----|----------|-------|--------------|-------------------|
| SF-001 | Warning | EME API not available | `navigator.requestMediaKeySystemAccess` is missing. DRM content cannot play natively. | Use HTTPS, try a modern browser, check if running in a restricted WebView. |
| SF-002 | Error | Not a secure context | Page loaded over HTTP. EME requires HTTPS (or localhost). | Switch to HTTPS. |
| SF-003 | Error | KID mismatch: manifest vs init segment | The Key ID in the manifest doesn't match the KID in the init segment's tenc box. The player will request the wrong key. | Re-package the content to ensure manifest and init segment KIDs match. |
| SF-004 | Warning | No PSSH boxes found | ContentProtection declares DRM systems but no PSSH box exists in manifest or init segment. Some CDMs need PSSH to request a license. | Add PSSH boxes to the manifest or init segment. |
| SF-005 | Error | Key status: output-restricted | The display doesn't meet HDCP requirements. Video renders as black. | Connect an HDCP-compliant display, or lower the content's HDCP requirement. |
| SF-006 | Error | Key status: expired | The license has expired. The CDM won't decrypt anymore. | Trigger a new license request (reload the page). |
| SF-007 | Error | Key status: internal-error | The CDM crashed or encountered a platform-level error (driver, TEE). | Restart the browser, update GPU drivers, check system logs. |
| SF-008 | Warning | Key status: output-downscaled | The display doesn't meet HDCP for the requested resolution. Content plays at reduced quality. | Connect an HDCP-compliant display for full resolution. |
| SF-009 | Error | No DRM system supported | Manifest declares multiple DRM systems but the browser couldn't use any of them. | Try a different browser, or check that the content includes a DRM system this browser supports. |
| SF-010 | Error | License server unreachable | Network error during license request. Server may be down or blocked by CORS. | Check network connectivity, verify the license URL, check CORS headers. |
| SF-011 | Error | License server rejected request | Server returned 4xx/5xx. Authentication or entitlement issue. | Verify the token is valid, check device certificate, confirm content entitlements. |
| SF-012 | Warning | Encryption scheme mismatch | Manifest declares one scheme (e.g., cenc) but init segment uses another (e.g., cbcs). Can cause silent failure on some platforms. | Re-package with consistent encryption scheme across manifest and init segments. |

#### Compat Tab

Probes the browser's DRM capabilities by attempting to access each key system.

Click **"Probe DRM support"** to run the check. Results show:

| Column | Description |
|--------|-------------|
| DRM System | Widevine, PlayReady, FairPlay, ClearKey |
| Status | Supported or Not found |
| Robustness | Highest supported security level (see below) |
| Key System | The key system identifier string |

The footer shows three environment checks:
- **EME API**: Whether `requestMediaKeySystemAccess` exists
- **Secure context**: Whether the page is served over HTTPS
- **SW decrypt**: Whether the Web Crypto API is available for software decryption fallback

**Widevine robustness levels** (from highest to lowest security):

| Level | Meaning |
|-------|---------|
| HW_SECURE_ALL | All crypto, decode, and processing in hardware TEE (L1) |
| HW_SECURE_DECODE | Decoding in hardware TEE, crypto may be in software |
| HW_SECURE_CRYPTO | Crypto in hardware TEE, decode in software |
| SW_SECURE_DECODE | Decode in software with some protection (L2) |
| SW_SECURE_CRYPTO | All in software (L3) — equivalent to ClearKey security |

**PlayReady robustness levels:**

| Level | Meaning |
|-------|---------|
| 3000 | Hardware DRM (SL3000) |
| 2000 | Software DRM with enhanced protection (SL2000) |
| 150 | Software DRM, basic protection (SL150) |

### Exporting Reports

The panel footer has two export buttons:

- **Copy**: Copies a text summary of all diagnostics data to the clipboard — useful for pasting into bug reports or chat
- **PDF**: Opens a print-friendly report in a new window that can be saved as PDF via the browser's print dialog

### Orange Badge Indicator

When DRM diagnostics detect issues (any SF-001 through SF-012 check fires), an orange badge appears on the DRM Diagnostics menu item in the right-click context menu. This serves as a passive alert — you don't need to open the panel to know something needs attention.

---

## 5. Forensic Watermark

### What It Is

When the license server includes a watermark token in its response, the player renders a barely visible text overlay on top of the video. This watermark identifies the viewing session, making it possible to trace the source of unauthorized screen recordings.

### What Users See

The watermark consists of a short session identifier (4 characters) rendered in 14px monospace text at very low opacity (approximately 3%). Under normal viewing conditions, it is essentially invisible. However, it becomes detectable when:

- Adjusting screen brightness/contrast
- Analyzing pixel data in captured screenshots
- Processing screen recordings with forensic tools

### How It Appears

Five copies of the session code are scattered across the video area at random positions and slight rotations (-15 to +15 degrees). The positions change every 30 seconds using a seeded pseudo-random number generator, so every 30-second window of a screen recording contains the watermark at different locations — making it harder to remove by masking a fixed region.

The watermark only appears over the actual video content, not the letterbox bars.

### Session Rotation

The watermark repositions every 30 seconds. The positions are deterministic (derived from the current 30-second time window), so the same session playing at the same time will produce the same pattern — useful for forensic verification.

---

## 6. Troubleshooting Guide

### Decision Tree: "Video Won't Play"

```
Video won't play
    |
    +-- Is the stream encrypted?
    |   (Check: does the diagnostics panel show ContentProtection / HLS Keys?)
    |       |
    |       +-- No --> Problem is not DRM-related (check network, codec support)
    |       |
    |       +-- Yes --> Continue below
    |
    +-- Is the diagnostics badge orange?
    |       |
    |       +-- Yes --> Open diagnostics panel (press D)
    |       |           Check the Diagnostics tab for specific failure codes
    |       |           (see SF-001 through SF-012 table above)
    |       |
    |       +-- No --> Continue below
    |
    +-- Did you provide key/license parameters?
    |       |
    |       +-- No --> Add ?key= or ?license=&token=&asset= parameters
    |       |
    |       +-- Yes --> Continue below
    |
    +-- Check the License tab in diagnostics:
    |       |
    |       +-- No exchanges shown --> License request never fired
    |       |   (check URL parameters, look for EME errors in Timeline tab)
    |       |
    |       +-- Exchange shows error --> See error column
    |       |   (HTTP 401 = bad token, 403 = no entitlement, 5xx = server error)
    |       |
    |       +-- Exchange shows 200 --> Key was delivered
    |           Check Timeline tab for key-status-change events
    |
    +-- Check Timeline tab:
            |
            +-- STATUS shows "output-restricted" --> HDCP issue (SF-005)
            +-- STATUS shows "expired" --> License expired (SF-006)
            +-- ERROR event --> Read the error detail
            +-- No events at all --> EME not initialized (SF-001 or SF-002?)
```

### Common Issues

| Symptom | Likely Cause | How to Fix |
|---------|-------------|------------|
| "Unable to decrypt" or black video with no audio | Wrong key provided | Verify the `key` parameter matches the content's KID. Open the Metadata tab to see the expected KID. |
| "License server returned HTTP 401" | Invalid or expired authentication token | Generate a fresh token and update the `token` parameter. |
| "License server returned HTTP 403" | No entitlement for this asset | Check that the user/token has access to this asset ID. |
| "License server returned HTTP 5xx" | Server-side error | Check the license server logs. The License tab shows the full request for debugging. |
| Black screen with audio playing | HDCP / output-restricted (SF-005) | Connect an HDCP-compliant monitor, or test on a device that meets the content's output protection requirements. |
| Plays on Chrome but fails on Safari | Content uses Widevine only, no FairPlay signaling | Ensure the content is packaged with both Widevine and FairPlay DRM, or use the license server which auto-routes to `/license/fairplay`. |
| Plays on Safari but fails on Chrome | Content uses FairPlay only (HLS with `com.apple.streamingkeydelivery`) | Package a DASH version with Widevine ContentProtection for Chrome. |
| "Software decrypt active" in console | ClearKey EME failed silently, player fell back to JavaScript decryption | This is usually fine — the player handles it automatically. Playback works, just without hardware DRM. If performance is an issue, try Chrome or Firefox which have reliable ClearKey EME. |
| Video plays at lower quality than expected | Output-downscaled (SF-008) | The display doesn't meet HDCP for the requested resolution. Connect a compliant display. |
| Playback stops after a while | License expired (SF-006) or session revoked | Check the session heartbeat. The license policy's `renewal_interval_s` determines heartbeat frequency. If the server returns "revoke", the session was terminated server-side. |
| "No DRM system supported" (SF-009) | Browser can't use any of the DRM systems in the manifest | Try a different browser, or package the content with additional DRM systems. |

### Using the Exported Report for Bug Reports

When filing a DRM-related bug:

1. Open the DRM Diagnostics panel (press **D**)
2. Click through all tabs to ensure data is loaded (especially click "Probe DRM support" on the Compat tab)
3. Click **Copy** in the panel footer
4. Paste the report into your bug ticket

The report includes: manifest DRM metadata, EME event timeline, license exchange details (with sensitive fields masked), diagnostic check results, and browser compatibility probe results.

---

## 7. Technical Reference

### DRM System UUID Mapping

| UUID | DRM System |
|------|-----------|
| `edef8ba9-79d6-4ace-a3c8-27dcd51d21ed` | Widevine |
| `9a04f079-9840-4286-ab92-e65be0885f95` | PlayReady |
| `94ce86fb-07ff-4f43-adb8-93d2fa968ca2` | FairPlay |
| `1077efec-c0b2-4d02-ace3-3c1e52e2fb4b` | ClearKey (W3C) |
| `e2719d58-a985-b3c9-781a-b030af78d30e` | ClearKey (DASH-IF) |

These UUIDs appear in DASH manifests as `urn:uuid:<UUID>` in ContentProtection `schemeIdUri` attributes, and as SystemID fields in PSSH boxes.

### PSSH Box Format

A PSSH (Protection System Specific Header) box contains:

| Field | Size | Description |
|-------|------|-------------|
| System ID | 16 bytes | UUID identifying the DRM system |
| Version | 4 bits | PSSH version (0 or 1) |
| Key IDs | variable | (Version 1 only) List of KIDs this PSSH applies to |
| Data | variable | System-specific payload |

**Widevine PSSH decoded fields:**
- Algorithm — encryption algorithm used
- Key IDs — list of KIDs (hex)
- Provider — content provider name
- Content ID — content identifier (hex and UTF-8)
- Policy — policy name string
- Protection Scheme — `cenc` or `cbcs`

**PlayReady PSSH decoded fields:**
- KID — Key ID
- LA URL — License Acquisition URL
- LUI URL — License UI URL
- Custom Attributes — provider-specific data

### EME Event Type Reference

| Event Type | When It Fires |
|-----------|---------------|
| `access-request` | Player calls `requestMediaKeySystemAccess()` |
| `access-granted` | Browser returns a `MediaKeySystemAccess` object |
| `access-denied` | Browser rejects the key system |
| `keys-created` | `MediaKeys` object created from the access object |
| `keys-set` | `MediaKeys` attached to the video element via `setMediaKeys()` |
| `generate-request` | `MediaKeySession.generateRequest()` called with init data |
| `message` | CDM generates a license request message (challenge) |
| `update` | `MediaKeySession.update()` called with the license response |
| `key-status-change` | CDM reports key status change (usable, expired, etc.) |
| `close` | `MediaKeySession.close()` called |
| `expiration-change` | License expiration time updated by the CDM |
| `error` | Any error in the EME pipeline |

### License Exchange Fields

**Request fields sent to the license server:**

| Field | Description |
|-------|-------------|
| `session_token` | Authentication token (from the `token` URL parameter) |
| `asset_id` | Content identifier (from the `asset` URL parameter) |
| `device_fingerprint` | Browser fingerprint for device identification |
| `client_public_key` | (ClearKey) ECDH ephemeral public key for key transport encryption |
| `challenge` | (Widevine) Base64-encoded CDM challenge bytes |
| `spc` | (FairPlay) Base64-encoded Server Playback Context |

**Response fields from the license server:**

| Field | Description |
|-------|-------------|
| `session_id` | Server-assigned session identifier |
| `keys` | (ClearKey) Array of `{kid, key, type}` entries |
| `license` | (Widevine) Base64-encoded license bytes for the CDM |
| `ckc` | (FairPlay) Base64-encoded Content Key Context |
| `policy` | License constraints: expiry time, renewal interval, max resolution, offline permission |
| `transport_key_params` | (ClearKey) ECDH-ES+A256KW parameters when keys are transport-encrypted |
| `watermark` | Forensic watermark config: user hash, session code, opacity |
| `evicted_sessions` | (Widevine/FairPlay) List of session IDs evicted due to concurrency limits |

### Encryption Schemes: CENC vs CBCS

| Property | CENC | CBCS |
|----------|------|------|
| Full name | Common Encryption (CTR mode) | Common Encryption (CBC mode with subsample patterns) |
| Cipher | AES-128-CTR | AES-128-CBC |
| Pattern | Full sample encryption | 1:9 pattern (encrypt 1 block, skip 9) |
| IV handling | Per-sample IV from senc box | Constant IV from tenc box |
| Platform | Widely supported (all browsers) | Required by Apple (FairPlay), supported by most modern browsers |
| Software decrypt | Supported by this player | Not supported by this player |

Content that uses CENC works on all platforms. Content that uses CBCS requires native CDM support (no software fallback available).

### Key Status Values

These values are reported by the CDM via EME's `keystatuseschange` event:

| Status | Meaning |
|--------|---------|
| `usable` | Key is valid and decryption is active |
| `expired` | License has expired, key can no longer be used |
| `released` | Key has been released (session closed) |
| `output-restricted` | Output doesn't meet HDCP requirements — video is black |
| `output-downscaled` | Output is downscaled because display doesn't meet HDCP for requested resolution |
| `status-pending` | Key status is being determined (temporary) |
| `internal-error` | CDM encountered an error (driver, hardware, or CDM crash) |

### Session Management

When using a license server, the player maintains an active session:

- **Heartbeats**: Sent at the interval specified by `policy.renewal_interval_s` (default varies by server). Each heartbeat reports playback position, buffer health, and current rendition.
- **Adaptive interval**: If the server responds with a different `next_heartbeat_s`, the player adjusts its heartbeat frequency.
- **Revocation**: If the server responds with `status: "revoke"`, the player stops playback and reports the session was terminated.
- **Session end**: When the page unloads or playback ends, the player sends a session-end notification via `sendBeacon` (survives page close) or `fetch` with `keepalive`.
- **Concurrency limits**: The server may evict older sessions when a new one starts (returned as `evicted_sessions` in the license response).
