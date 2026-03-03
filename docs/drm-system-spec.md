# Custom DRM System Specification

## 1. Industry Landscape & Design Rationale

### 1.1 What the Big Players Do Well

| System | Best Design Aspect | Weakness |
|--------|--------------------|----------|
| **Widevine** | Tiered security (L1/L2/L3), broad reach, hardware TEE at L1 | L3 (software-only) is routinely broken; key extraction tools are public |
| **FairPlay** | Tight hardware lock — Apple controls the entire chain from silicon to Safari | Walled garden; HLS-only; requires $99/yr Apple developer account |
| **PlayReady** | Flexible license policies (rental, subscription, offline), key rotation built-in | Complex integration; Windows/Xbox-centric |
| **WisePlay** | DASH+HLS dual support on Huawei devices | Huawei ecosystem only; small market share |
| **Spotify** | App-level DRM — no browser CDM dependency; backend-enforced entitlements | Only works in their native app; not applicable to browser playback |

**Key takeaway**: No single DRM covers all platforms. The industry standard is multi-DRM orchestration with CENC as the common encryption layer. For a custom system without native CDM support, the realistic threat model is: **you cannot prevent a determined attacker with dev tools from extracting keys** (this is equivalent to Widevine L3, which is broken). The goal shifts to making casual piracy inconvenient and making leaks traceable.

### 1.2 Our Position

We operate at the **ClearKey / software decryption** level (equivalent to Widevine L3). This means:

- No hardware TEE — keys are in JavaScript memory
- The browser is an untrusted environment
- Our protection is against **casual copying**, not nation-state attackers

This is the same tier as most web-based video platforms without L1 partnerships. The spec below maximizes security within this constraint.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     CONTENT PIPELINE                         │
│                                                              │
│  Source ──► Packager ──► Encrypted DASH/HLS ──► CDN/Origin   │
│               │                                              │
│               ▼                                              │
│        Key Management                                        │
│         Service (KMS)                                        │
└──────────────┬──────────────────────────────────────────────┘
               │ CPIX / internal API
               ▼
┌──────────────────────────────────────────────────────────────┐
│                     LICENSE SERVER                            │
│                                                              │
│  Auth ──► Entitlement ──► Key Derivation ──► License Response │
│   │           │                                   │          │
│   │           ▼                                   ▼          │
│   │     Policy Engine                      Analytics/Audit   │
│   │    (tier, expiry,                      (consumption,     │
│   │     device limits)                      anomaly detect)  │
│   │                                                          │
│   ▼                                                          │
│  Session Store (Redis)                                       │
└──────────────────────────────────────────────────────────────┘
               │ License (encrypted content keys)
               ▼
┌──────────────────────────────────────────────────────────────┐
│                     PLAYER (CLIENT)                           │
│                                                              │
│  Shaka Player ──► License Interceptor ──► Key Unwrap         │
│       │               │                      │               │
│       ▼               ▼                      ▼               │
│  EME (ClearKey)   Session Mgmt      Software Decrypt         │
│  or Software      (heartbeat,       (AES-CTR via             │
│  Fallback         renewal)          Web Crypto API)          │
│       │                                                      │
│       ▼                                                      │
│  Forensic Watermark Overlay                                  │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Components

| Component | Responsibility |
|-----------|---------------|
| **Packager** | Encrypts content with per-track keys, generates DASH/HLS manifests with DRM signaling |
| **Key Management Service (KMS)** | Generates, stores, and derives content encryption keys (CEKs); never exposed to clients |
| **License Server** | Authenticates users, checks entitlements, wraps CEKs for delivery, logs consumption |
| **Player (Client)** | Requests licenses, unwraps keys, decrypts content, renders watermark, sends heartbeats |
| **Session Store** | Tracks active sessions, enforces concurrency limits, enables key rotation |

---

## 3. Content Encryption

### 3.1 Multi-Key Per-Track Encryption

Different quality tiers get different encryption keys. This prevents a user entitled to SD from decrypting 4K content even if they intercept the stream.

```
Content Asset "movie-123"
├── Audio Track        ──► KEK_audio    (Key ID: kid_audio)
├── SD Video  (≤720p)  ──► KEK_sd      (Key ID: kid_sd)
├── HD Video  (1080p)  ──► KEK_hd      (Key ID: kid_hd)
├── UHD Video (4K)     ──► KEK_uhd     (Key ID: kid_uhd)
└── Subtitles          ──► unencrypted
```

**DASH manifest signaling** — each `AdaptationSet` carries its own `ContentProtection` with a distinct `cenc:default_KID`:

```xml
<AdaptationSet mimeType="video/mp4" maxHeight="720">
  <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"
                     value="cenc"
                     cenc:default_KID="a1b2c3d4-..."/>
  <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e">
    <cenc:pssh>...</cenc:pssh>  <!-- ClearKey PSSH -->
  </ContentProtection>
</AdaptationSet>

<AdaptationSet mimeType="video/mp4" maxHeight="2160">
  <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"
                     value="cenc"
                     cenc:default_KID="e5f6a7b8-..."/>  <!-- different KID -->
  <!-- ... -->
</AdaptationSet>
```

### 3.2 Encryption Scheme

| Parameter | Value |
|-----------|-------|
| Scheme | CENC (AES-128-CTR) for DASH; CBCS (AES-128-CBC with subsample patterns) for HLS/CMAF |
| IV size | 8 or 16 bytes (per-sample IVs recommended) |
| Subsample encryption | Yes — NALU header clear, payload encrypted |
| Key length | 128-bit AES |

### 3.3 Key Hierarchy

```
Master Key (HSM-protected, never leaves KMS)
    │
    ├── derive(asset_id, "audio")   ──► CEK_audio
    ├── derive(asset_id, "sd")      ──► CEK_sd
    ├── derive(asset_id, "hd")      ──► CEK_hd
    └── derive(asset_id, "uhd")     ──► CEK_uhd

Derivation: CEK = HKDF-SHA256(masterKey, salt=asset_id, info=track_label)
```

- Master key stored in HSM or Vault (never in application code)
- CEKs are deterministic — same inputs always produce the same key (enables re-packaging without key storage per asset)
- Key IDs (KIDs) are UUIDv5 derived from `(asset_id, track_label)` for deterministic mapping

---

## 4. License Server

### 4.1 License Request Flow

```
Player                          License Server                    KMS
  │                                  │                             │
  │  1. POST /license                │                             │
  │     { session_token,             │                             │
  │       kid[], device_fp }         │                             │
  │  ──────────────────────────►     │                             │
  │                                  │  2. Validate session_token  │
  │                                  │     (JWT signature, expiry, │
  │                                  │      entitlements)          │
  │                                  │                             │
  │                                  │  3. Check entitlements:     │
  │                                  │     user tier vs requested  │
  │                                  │     KIDs                    │
  │                                  │                             │
  │                                  │  4. GET /derive             │
  │                                  │  ──────────────────────►    │
  │                                  │                             │
  │                                  │  5. CEKs for allowed KIDs   │
  │                                  │  ◄──────────────────────    │
  │                                  │                             │
  │                                  │  6. Wrap CEKs with          │
  │                                  │     session-specific        │
  │                                  │     transport key           │
  │                                  │                             │
  │  7. License response             │                             │
  │     { wrapped_keys[],            │                             │
  │       policy, watermark_token,   │                             │
  │       next_renewal }             │                             │
  │  ◄──────────────────────────     │                             │
  │                                  │                             │
  │  8. Unwrap keys locally          │                             │
  │     Configure Shaka DRM          │                             │
  │     Start playback               │                             │
```

### 4.2 Session Token (JWT)

Issued by the auth service on login. Sent with every license request.

```json
{
  "sub": "user-uuid-123",
  "iat": 1709500000,
  "exp": 1709503600,
  "tier": "premium",
  "entitled_assets": ["movie-123", "series-456"],
  "max_resolution": "4k",
  "max_concurrent": 2,
  "device_id": "fp-sha256-abc",
  "iss": "auth.example.com",
  "jti": "unique-token-id"
}
```

| Claim | Purpose |
|-------|---------|
| `tier` | Maps to key tiers (sd/hd/uhd) — a "basic" user never receives UHD keys |
| `entitled_assets` | Explicit asset whitelist (or `"*"` for subscription) |
| `max_resolution` | Hard cap — license server filters out KIDs above this tier |
| `max_concurrent` | Concurrent stream limit enforced via session store |
| `device_id` | Browser fingerprint hash — binds session to device |
| `jti` | Token ID for revocation and replay prevention |

### 4.3 License Response

```json
{
  "session_id": "sess-uuid-789",
  "keys": [
    {
      "kid": "a1b2c3d4...",
      "key": "<base64 AES-wrapped CEK>",
      "type": "audio"
    },
    {
      "kid": "c3d4e5f6...",
      "key": "<base64 AES-wrapped CEK>",
      "type": "sd"
    }
  ],
  "transport_key_params": {
    "algorithm": "ECDH-ES+A256KW",
    "epk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }
  },
  "policy": {
    "expiry": "2024-03-01T12:30:00Z",
    "renewal_interval_s": 300,
    "max_resolution": 1080,
    "allow_offline": false
  },
  "watermark": {
    "user_hash": "7f3a...",
    "session_short": "X9K2",
    "opacity": 0.03
  }
}
```

### 4.4 Key Transport Protection

CEKs must never travel in plaintext. Two options:

**Option A: ECDH Ephemeral Key Agreement (recommended)**

```
Client                              Server
  │                                    │
  │  Generate ephemeral EC key pair    │
  │  (P-256)                           │
  │                                    │
  │  Send public key in license req    │
  │  ──────────────────────────────►   │
  │                                    │
  │           Server generates own ephemeral pair
  │           ECDH shared secret = client_priv × server_pub
  │           Derive wrapping key via HKDF
  │           Wrap each CEK with AES-KW
  │                                    │
  │  Receive server ephemeral pub +    │
  │  wrapped CEKs                      │
  │  ◄──────────────────────────────   │
  │                                    │
  │  ECDH shared secret =             │
  │    client_priv × server_pub        │
  │  Derive same wrapping key          │
  │  Unwrap CEKs                       │
```

- Forward secrecy: each request uses fresh ephemeral keys
- Web Crypto API supports ECDH + AES-KW natively
- No long-term key material stored on client

**Option B: RSA-OAEP (simpler, no forward secrecy)**

- Server has an RSA public key baked into the player
- Server encrypts CEKs with RSA-OAEP
- Simpler but compromised server key = all past sessions compromised

### 4.5 Entitlement Rules

```
Tier "free"     → audio + sd keys only, max 480p
Tier "basic"    → audio + sd + hd keys, max 1080p
Tier "premium"  → audio + sd + hd + uhd keys, max 4K
Tier "trial"    → same as basic, but expiry = 7 days, no offline
```

The license server NEVER sends keys the user isn't entitled to. A "basic" user requesting `kid_uhd` receives a license with only `kid_audio + kid_sd + kid_hd`. The player gracefully falls back to the highest available quality.

---

## 5. Session Management

### 5.1 Session Lifecycle

```
┌──────────┐     license_request     ┌──────────┐
│  INIT    │ ──────────────────────► │  ACTIVE  │
└──────────┘                         └────┬─────┘
                                          │
                              ┌───────────┼───────────┐
                              │           │           │
                         heartbeat    renewal     timeout
                         (30s)        (5min)      (no heartbeat
                              │           │        for 2min)
                              │           │           │
                              ▼           ▼           ▼
                         ┌────────┐  ┌────────┐  ┌────────┐
                         │ ACTIVE │  │ ACTIVE │  │ EXPIRED│
                         │(extend)│  │(new key│  │        │
                         └────────┘  │ period)│  └────────┘
                                     └────────┘
```

### 5.2 Heartbeat Protocol

The player sends periodic heartbeats to keep the session alive. This enables:
- **Concurrency enforcement**: server knows exactly how many streams are active
- **Consumption tracking**: server logs watch duration per asset
- **Revocation**: server can kill a session by responding with `revoke: true`

```
POST /session/heartbeat
{
  "session_id": "sess-uuid-789",
  "position_s": 1234.5,
  "buffer_health_s": 15.2,
  "rendition": "1080p",
  "timestamp": 1709501234
}

Response 200:
{
  "status": "ok",
  "next_heartbeat_s": 30
}

Response 200 (revoke):
{
  "status": "revoke",
  "reason": "concurrent_limit_exceeded"
}

Response 401 (session expired):
{
  "error": "session_expired"
}
```

### 5.3 Concurrency Limiting

```
On license_request:
  active = redis.SCARD("user:{user_id}:sessions")
  if active >= max_concurrent:
    oldest = redis.SMEMBERS("user:{user_id}:sessions").sort_by_created()
    # Option A: reject new session
    return 403 "concurrent_limit"
    # Option B: kill oldest session (Netflix model)
    redis.SREM("user:{user_id}:sessions", oldest.session_id)
    push_revoke(oldest.session_id)

  redis.SADD("user:{user_id}:sessions", session_id)
  redis.EXPIRE("user:{user_id}:sessions", 120)  # auto-cleanup
```

### 5.4 Key Rotation (Live Streams)

For live content, keys rotate every N minutes. The manifest signals key periods:

```xml
<Period id="period-1" start="PT0S" duration="PT10M">
  <ContentProtection cenc:default_KID="kid-period-1"/>
</Period>
<Period id="period-2" start="PT10M" duration="PT10M">
  <ContentProtection cenc:default_KID="kid-period-2"/>
</Period>
```

The player detects a new KID when crossing period boundaries and automatically requests a new license. The license server derives period-specific keys:

```
CEK_period = HKDF-SHA256(masterKey, salt=asset_id||period_index, info=track_label)
```

For VOD, key rotation is optional but can be used to limit the blast radius of a leaked key (e.g., rotate every 10 minutes of content).

---

## 6. Client (Player) Implementation

### 6.1 Integration with Existing Codebase

The DRM client integrates as a new module alongside the existing `softwareDecrypt.ts` and `cencDecrypt.ts`:

```
src/
├── drm/
│   ├── drmClient.ts           # Main DRM orchestrator
│   ├── licenseInterceptor.ts   # Shaka request/response filter
│   ├── keyUnwrap.ts            # ECDH + AES-KW key unwrapping
│   ├── sessionManager.ts       # Heartbeat, renewal, lifecycle
│   ├── deviceFingerprint.ts    # Browser fingerprinting
│   ├── watermarkRenderer.ts    # Canvas-based forensic watermark
│   └── types.ts                # Shared types
├── workers/
│   └── cencDecrypt.ts          # (existing) — reused for software decrypt path
└── utils/
    └── softwareDecrypt.ts      # (existing) — fallback path unchanged
```

### 6.2 DRM Client (`drmClient.ts`)

The orchestrator that replaces the current manual key prompt flow.

```typescript
interface DrmClientConfig {
  licenseServerUrl: string;
  sessionToken: string;          // JWT from auth service
  assetId: string;
  deviceFingerprint: string;
  onSessionRevoked?: () => void;
  onKeyRotation?: (periodIndex: number) => void;
}

interface DrmClient {
  /** Called once before player.load(). Sets up Shaka DRM config. */
  configure(player: shaka.Player): Promise<void>;

  /** Start heartbeat loop. Call after playback begins. */
  startSession(videoEl: HTMLVideoElement): void;

  /** Clean shutdown — notify server, stop heartbeat. */
  destroy(): Promise<void>;
}
```

**Flow**:

1. `configure()` is called before `player.load()`
2. Registers a Shaka license request filter that intercepts ClearKey license requests
3. The filter calls the license server instead of using static keys
4. Response keys are unwrapped via ECDH and passed to Shaka's ClearKey handler
5. For browsers without EME, falls back to `configureSoftwareDecryption()` with the unwrapped keys
6. `startSession()` begins the heartbeat loop
7. On `destroy()`, sends a session-end event and stops heartbeats

### 6.3 License Interceptor (`licenseInterceptor.ts`)

Hooks into Shaka's networking engine to redirect license requests to our server.

```typescript
export function installLicenseInterceptor(
  player: shaka.Player,
  config: DrmClientConfig,
  keyStore: Map<string, CryptoKey>,  // kid → unwrapped CryptoKey
): void {
  const netEngine = player.getNetworkingEngine();

  // Request filter: intercept license requests
  netEngine.registerRequestFilter(async (type, request) => {
    if (type !== shaka.net.NetworkingEngine.RequestType.LICENSE) return;

    // Extract requested KIDs from the license request body
    const kids = extractKidsFromRequest(request);

    // Generate ephemeral ECDH key pair
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );

    // Build license request to our server
    const licenseResponse = await fetchLicense({
      url: config.licenseServerUrl,
      sessionToken: config.sessionToken,
      assetId: config.assetId,
      kids,
      deviceFingerprint: config.deviceFingerprint,
      clientPublicKey: await exportPublicKey(publicKey),
    });

    // Unwrap CEKs using ECDH shared secret
    const wrappingKey = await deriveWrappingKey(
      privateKey,
      licenseResponse.transport_key_params.epk,
    );

    for (const entry of licenseResponse.keys) {
      const cek = await unwrapKey(wrappingKey, entry.key);
      keyStore.set(entry.kid, cek);
    }

    // Rewrite request body to ClearKey format for Shaka
    request.body = buildClearKeyLicenseBody(licenseResponse.keys);
  });
}
```

### 6.4 Session Manager (`sessionManager.ts`)

```typescript
export class SessionManager {
  private heartbeatTimer: number | null = null;
  private sessionId: string | null = null;

  async start(videoEl: HTMLVideoElement, sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    this.scheduleHeartbeat(videoEl, 30_000);
  }

  private scheduleHeartbeat(videoEl: HTMLVideoElement, intervalMs: number): void {
    this.heartbeatTimer = window.setInterval(async () => {
      const response = await fetch("/session/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: this.sessionId,
          position_s: videoEl.currentTime,
          buffer_health_s: getBufferHealth(videoEl),
          rendition: getCurrentRendition(),
          timestamp: Date.now(),
        }),
      });

      const data = await response.json();

      if (data.status === "revoke") {
        this.onRevoked(data.reason);
        return;
      }

      if (response.status === 401) {
        this.onExpired();
        return;
      }

      // Adaptive heartbeat interval
      if (data.next_heartbeat_s) {
        this.reschedule(videoEl, data.next_heartbeat_s * 1000);
      }
    }, intervalMs);
  }

  async destroy(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sessionId) {
      await fetch("/session/end", {
        method: "POST",
        body: JSON.stringify({ session_id: this.sessionId }),
      }).catch(() => {}); // best-effort
    }
  }
}
```

### 6.5 Device Fingerprinting (`deviceFingerprint.ts`)

Lightweight browser fingerprint to bind sessions to devices. Not for tracking — for preventing session token theft.

```typescript
export async function computeDeviceFingerprint(): Promise<string> {
  const signals = [
    navigator.userAgent,
    navigator.language,
    screen.width + "x" + screen.height,
    screen.colorDepth.toString(),
    navigator.hardwareConcurrency?.toString() ?? "?",
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Canvas fingerprint (hash only, not the image)
    await canvasHash(),
    // WebGL renderer string
    getWebGLRenderer(),
  ];

  const raw = signals.join("|");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

### 6.6 Forensic Watermark (`watermarkRenderer.ts`)

A semi-transparent overlay rendered on a canvas layer above the video. Contains user-identifiable info that survives screen recording.

```typescript
export function renderWatermark(
  canvas: HTMLCanvasElement,
  config: WatermarkConfig,
): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Position shifts every 30s to resist cropping
  const positionSeed = Math.floor(Date.now() / 30_000);
  const positions = getWatermarkPositions(positionSeed, canvas.width, canvas.height);

  ctx.font = "14px monospace";
  ctx.fillStyle = `rgba(255, 255, 255, ${config.opacity})`;  // ~0.03 = nearly invisible
  ctx.globalCompositeOperation = "lighter";

  for (const pos of positions) {
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(pos.angle);
    // Short hash: "X9K2" — traceable to session but not PII
    ctx.fillText(config.sessionShort, 0, 0);
    ctx.restore();
  }
}
```

**Properties**:
- Opacity ~3% — invisible to viewers, detectable by forensic tools
- Position rotates every 30 seconds — resists static crop removal
- Encodes session short code (4 chars) — maps to user+device+time on server
- Rendered on a canvas overlay, not burned into the video stream (client-side approach)

### 6.7 Key Unwrap (`keyUnwrap.ts`)

```typescript
export async function deriveWrappingKey(
  clientPrivateKey: CryptoKey,
  serverEpk: JsonWebKey,
): Promise<CryptoKey> {
  const serverPublicKey = await crypto.subtle.importKey(
    "jwk",
    serverEpk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPublicKey },
    clientPrivateKey,
    256,
  );

  // HKDF to derive AES-KW wrapping key
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("drm-key-wrap") },
    hkdfKey,
    { name: "AES-KW", length: 256 },
    false,
    ["unwrapKey"],
  );
}

export async function unwrapKey(
  wrappingKey: CryptoKey,
  wrappedKeyB64: string,
): Promise<CryptoKey> {
  const wrappedBytes = Uint8Array.from(atob(wrappedKeyB64), (c) => c.charCodeAt(0));

  return crypto.subtle.unwrapKey(
    "raw",
    wrappedBytes,
    wrappingKey,
    "AES-KW",
    { name: "AES-CTR" },
    false,
    ["decrypt"],
  );
}
```

---

## 7. Server Implementation

### 7.1 Technology Stack

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| License Server | Go or Rust | High throughput, low latency, easy to deploy |
| Session Store | Redis | Fast TTL-based expiry, pub/sub for revocation |
| KMS | HashiCorp Vault Transit Engine | HSM-backed key derivation without key export |
| Auth | Existing auth service | JWT issuance; DRM server validates, doesn't issue |
| Database | PostgreSQL | Asset metadata, entitlements, audit logs |
| Message Queue | Redis Streams or NATS | Async analytics events |

### 7.2 License Server API

#### `POST /license`

Request:
```json
{
  "session_token": "<JWT>",
  "asset_id": "movie-123",
  "kids": ["a1b2c3d4...", "e5f6a7b8..."],
  "device_fingerprint": "sha256hex...",
  "client_public_key": {
    "kty": "EC",
    "crv": "P-256",
    "x": "base64url...",
    "y": "base64url..."
  }
}
```

Response (200):
```json
{
  "session_id": "sess-uuid-789",
  "keys": [
    { "kid": "a1b2c3d4...", "key": "<base64 AES-KW wrapped>", "type": "audio" },
    { "kid": "c3d4e5f6...", "key": "<base64 AES-KW wrapped>", "type": "sd" }
  ],
  "transport_key_params": {
    "algorithm": "ECDH-ES+A256KW",
    "epk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." }
  },
  "policy": {
    "expiry": "2024-03-01T12:30:00Z",
    "renewal_interval_s": 300,
    "max_resolution": 1080,
    "allow_offline": false
  },
  "watermark": {
    "user_hash": "7f3a...",
    "session_short": "X9K2",
    "opacity": 0.03
  }
}
```

Response (403 — entitlement denied):
```json
{
  "error": "entitlement_denied",
  "message": "Asset not in subscription",
  "entitled_tiers": ["sd"]
}
```

Response (429 — concurrent limit):
```json
{
  "error": "concurrent_limit",
  "active_sessions": 2,
  "max_sessions": 2
}
```

#### `POST /session/heartbeat`

See section 5.2.

#### `POST /session/end`

```json
{ "session_id": "sess-uuid-789" }
```

Response (200):
```json
{
  "total_watch_s": 3456,
  "asset_id": "movie-123"
}
```

#### `POST /license/renew`

Used for key rotation. Player calls this when it encounters a new KID.

Request:
```json
{
  "session_id": "sess-uuid-789",
  "new_kids": ["f9a0b1c2..."],
  "client_public_key": { ... }
}
```

Response: same shape as `/license` but only with the newly requested keys.

### 7.3 License Server Pseudocode

```
function handleLicenseRequest(req):
    # 1. Validate JWT
    token = verify_jwt(req.session_token, JWT_SECRET)
    if token.expired or token.revoked:
        return 401

    # 2. Check device fingerprint
    if token.device_id != hash(req.device_fingerprint):
        audit_log("device_mismatch", token.sub, req.device_fingerprint)
        return 403 "device_mismatch"

    # 3. Check concurrency
    active = redis.scard(f"user:{token.sub}:sessions")
    if active >= token.max_concurrent:
        return 429 "concurrent_limit"

    # 4. Determine entitled keys
    entitled_kids = []
    for kid in req.kids:
        track_type = kid_to_track_type(kid, req.asset_id)
        if resolution_for_type(track_type) <= token.max_resolution:
            entitled_kids.append(kid)

    if not entitled_kids:
        return 403 "entitlement_denied"

    # 5. Derive CEKs from KMS (keys never stored in license server)
    ceks = {}
    for kid in entitled_kids:
        track_label = kid_to_track_label(kid)
        ceks[kid] = kms.derive_key(
            master_key_id="content-master",
            context=f"{req.asset_id}:{track_label}"
        )

    # 6. ECDH key agreement
    server_keypair = generate_ecdh_keypair()
    shared_secret = ecdh(server_keypair.private, req.client_public_key)
    wrapping_key = hkdf_sha256(shared_secret, info="drm-key-wrap")

    # 7. Wrap CEKs
    wrapped_keys = []
    for kid, cek in ceks.items():
        wrapped = aes_kw_wrap(wrapping_key, cek)
        wrapped_keys.append({kid, key: base64(wrapped), type: track_label})

    # 8. Create session
    session_id = uuid()
    redis.sadd(f"user:{token.sub}:sessions", session_id)
    redis.hset(f"session:{session_id}", {
        user: token.sub,
        asset: req.asset_id,
        device: req.device_fingerprint,
        created: now(),
        last_heartbeat: now(),
        position: 0,
    })
    redis.expire(f"session:{session_id}", 120)  # 2min without heartbeat = dead

    # 9. Generate watermark token
    watermark = {
        user_hash: sha256(token.sub)[:8],
        session_short: base36(session_id)[:4],
        opacity: 0.03,
    }

    # 10. Audit log
    emit_event("license_issued", {
        user: token.sub,
        asset: req.asset_id,
        kids: entitled_kids,
        session_id,
        device: req.device_fingerprint,
    })

    return {
        session_id,
        keys: wrapped_keys,
        transport_key_params: { epk: export_public(server_keypair.public) },
        policy: build_policy(token),
        watermark,
    }
```

### 7.4 Key Management Service (KMS)

The KMS is a separate service (or Vault Transit engine) that:

1. Holds the master key in an HSM
2. Derives CEKs on demand via HKDF
3. Never returns the master key
4. Logs every derivation request
5. Supports key versioning (master key rotation without re-encrypting content)

```
POST /derive
{
  "master_key_version": 1,
  "context": "movie-123:uhd",
  "output_format": "raw"
}

Response:
{
  "key": "<base64 derived CEK>",
  "key_id": "e5f6a7b8-...",
  "master_version": 1
}
```

**Master key rotation**: When the master key is rotated, new content uses version N+1. Old content continues to work because the version is tracked per-asset. The KMS can derive from any version.

### 7.5 Consumption Analytics

Every heartbeat and session event feeds into the analytics pipeline:

```sql
CREATE TABLE consumption_events (
    id            BIGSERIAL PRIMARY KEY,
    event_type    TEXT NOT NULL,  -- 'session_start', 'heartbeat', 'session_end', 'seek', 'quality_change'
    session_id    UUID NOT NULL,
    user_id       UUID NOT NULL,
    asset_id      TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL,
    position_s    REAL,
    rendition     TEXT,
    device_fp     TEXT,
    metadata      JSONB
);

CREATE INDEX idx_consumption_user ON consumption_events (user_id, timestamp);
CREATE INDEX idx_consumption_asset ON consumption_events (asset_id, timestamp);
```

**Derived metrics**:
- Total watch time per user per asset
- Completion rate (% of asset watched)
- Peak concurrent viewers per asset
- Quality distribution (what % watched in 4K vs 1080p vs SD)
- Device distribution
- Anomaly detection: same user from multiple geolocations simultaneously

### 7.6 Anomaly Detection

```
Rules evaluated on each heartbeat:

1. GEO_MISMATCH
   If session.geo differs from user's last-known geo by >500km
   AND time since last session < 1 hour
   → Flag for review, optionally revoke

2. RAPID_SESSION_CHURN
   If user creates > 10 sessions in 1 hour
   → Rate limit, require re-auth

3. KEY_REQUEST_FLOOD
   If same user requests licenses for > 20 distinct assets in 1 hour
   → Suspicious scraping, throttle

4. DEVICE_FARM
   If user has > 5 distinct device fingerprints in 24 hours
   → Flag for review

5. POSITION_ANOMALY
   If heartbeat position jumps backwards by > 60s
   without a seek event
   → Possible replay/cloning
```

---

## 8. Content Packaging Pipeline

### 8.1 Packaging Flow

```
Source file (mezzanine)
    │
    ▼
Transcoder (ffmpeg / cloud encoder)
    │  Produces: multiple bitrate renditions (mp4 fragments)
    ▼
Packager (Shaka Packager / Bento4 mp4dash)
    │  Inputs: renditions + per-track CEKs from KMS
    │  Outputs: encrypted DASH manifest + encrypted segments
    │           encrypted HLS manifest + encrypted segments (optional)
    ▼
CDN upload
```

### 8.2 Shaka Packager Command (Multi-Key)

```bash
packager \
  in=video_sd.mp4,stream=video,output=video_sd_enc.mp4,drm_label=SD \
  in=video_hd.mp4,stream=video,output=video_hd_enc.mp4,drm_label=HD \
  in=video_uhd.mp4,stream=video,output=video_uhd_enc.mp4,drm_label=UHD \
  in=audio.mp4,stream=audio,output=audio_enc.mp4,drm_label=AUDIO \
  --enable_raw_key_encryption \
  --keys \
    label=AUDIO:key_id=<kid_audio>:key=<cek_audio>,\
    label=SD:key_id=<kid_sd>:key=<cek_sd>,\
    label=HD:key_id=<kid_hd>:key=<cek_hd>,\
    label=UHD:key_id=<kid_uhd>:key=<cek_uhd> \
  --protection_scheme cenc \
  --mpd_output manifest.mpd
```

### 8.3 Packaging Automation

```python
# packaging_service.py (simplified)

def package_asset(asset_id: str, renditions: list[Path]) -> None:
    # 1. Request per-track keys from KMS
    keys = {}
    for track_label in ["audio", "sd", "hd", "uhd"]:
        resp = kms_client.derive(context=f"{asset_id}:{track_label}")
        keys[track_label] = {
            "kid": resp["key_id"],
            "cek": resp["key"],
        }

    # 2. Build packager command
    cmd = build_packager_cmd(renditions, keys)
    subprocess.run(cmd, check=True)

    # 3. Upload to CDN
    upload_to_cdn(f"output/{asset_id}/")

    # 4. Register asset in catalog
    catalog.register(asset_id, kids={
        label: keys[label]["kid"] for label in keys
    })
```

---

## 9. Security Considerations

### 9.1 Threat Model

| Threat | Mitigation | Residual Risk |
|--------|-----------|---------------|
| **Key extraction from JS memory** | ECDH transport encryption, short-lived keys, key rotation | Cannot prevent determined attacker with debugger (same as Widevine L3) |
| **Session token theft** | Short JWT expiry (1h), device fingerprint binding, refresh tokens | Stolen refresh token + matching device = compromised |
| **Man-in-the-middle** | HTTPS everywhere, HPKP/CT for certificate pinning | Compromised CA |
| **Screen recording** | Forensic watermark overlay | Attacker can crop/resize to remove watermark |
| **Manifest/segment URL scraping** | Signed URLs with short TTL (5min), referer checks | Automated scraping within TTL window |
| **Credential sharing** | Concurrency limits, device limits, geo anomaly detection | Users sharing within limits |
| **Key server compromise** | KMS with HSM-backed master key, audit logs | HSM compromise (extremely unlikely) |
| **Replay attacks** | Nonce in license requests, JWT `jti` claim, session binding | — |

### 9.2 What We Cannot Prevent (and Industry Doesn't Either at L3)

1. **Analog hole**: Screen recording always works. Watermarking is the only mitigation.
2. **Debugger key extraction**: JavaScript keys are in memory. Even Widevine L3 CDMs (software-only) are routinely broken.
3. **Browser extension injection**: Extensions can intercept decrypted frames.

These are accepted risks at the software DRM tier. The industry addresses them with:
- Hardware DRM (L1) for premium content — requires OEM partnerships
- Forensic watermarking for leak tracing
- Legal enforcement (DMCA takedowns)

### 9.3 Hardening Checklist

- [ ] All license server endpoints behind HTTPS with HSTS
- [ ] JWT signing key rotated quarterly, old keys kept for validation window
- [ ] Rate limiting on `/license` endpoint (10 req/min per user)
- [ ] Rate limiting on `/session/heartbeat` (burst of 5, sustain 1/30s)
- [ ] License server logs every request with user ID, asset ID, IP, and device fingerprint
- [ ] KMS audit log for every key derivation
- [ ] Signed manifest/segment URLs with 5-minute TTL
- [ ] CORS restricted to player origin
- [ ] CSP headers preventing script injection
- [ ] No CEK in license server logs — only KIDs
- [ ] Automated anomaly detection with alerting
- [ ] Watermark session codes stored server-side for forensic lookup

---

## 10. Migration Path from Current ClearKey

### Phase 1: License Server MVP

**Goal**: Replace manual key prompt with server-issued keys. No breaking changes.

1. Deploy license server with single-key mode (one key per asset, like today)
2. Add `drmClient.ts` to player — intercepts where `handleKeySubmit` currently works
3. Existing `?key=` URL param remains as a dev/debug override
4. Software decrypt fallback path unchanged
5. Heartbeat + session tracking active but not enforced

**Player changes**: ~200 lines in new `src/drm/` module. ShakaPlayer.tsx changes: replace key prompt modal with auto-license-fetch.

### Phase 2: Multi-Key + Entitlements

1. Packager produces multi-key encrypted content
2. License server returns only entitled keys per user tier
3. Player handles partial key sets gracefully (Shaka auto-selects highest available quality)
4. Concurrency enforcement turned on

### Phase 3: Key Transport Protection

1. ECDH key exchange replaces plaintext key delivery
2. Device fingerprinting active
3. Session token binding to device

### Phase 4: Watermarking + Analytics

1. Canvas-based forensic watermark overlay
2. Consumption analytics pipeline
3. Anomaly detection rules
4. Signed manifest URLs

### Phase 5 (Optional): External DRM Integration

If the service scales to require L1 protection:
1. Add Widevine license proxy (forwards to Widevine license server)
2. Add FairPlay KSM integration for Safari/iOS
3. Custom DRM becomes the fallback for unsupported platforms
4. CPIX-based key exchange between packager and multi-DRM key server

---

## 11. API Summary for Agentic Development

### Client-Side Tasks (TypeScript/React)

| Module | Input | Output | Dependencies |
|--------|-------|--------|-------------|
| `drmClient.ts` | `DrmClientConfig` | Configured Shaka player with DRM | `licenseInterceptor`, `sessionManager`, `keyUnwrap` |
| `licenseInterceptor.ts` | Shaka `NetworkingEngine`, license server URL | ClearKey config or software decrypt setup | `keyUnwrap`, existing `softwareDecrypt.ts` |
| `keyUnwrap.ts` | Server ephemeral public key, wrapped key bytes | `CryptoKey` (AES-CTR) | Web Crypto API |
| `sessionManager.ts` | Session ID, video element | Heartbeat loop, revocation handling | Fetch API |
| `deviceFingerprint.ts` | — | SHA-256 hex string | Canvas, WebGL, Web Crypto |
| `watermarkRenderer.ts` | Canvas element, watermark config | Rendered overlay | Canvas 2D API |

### Server-Side Tasks (Go/Rust)

| Module | Input | Output | Dependencies |
|--------|-------|--------|-------------|
| `license_handler` | License request JSON | License response JSON | KMS client, Redis, JWT validator |
| `session_handler` | Heartbeat/end request | Session state update | Redis |
| `entitlement_engine` | JWT claims, requested KIDs | Filtered KID list | Asset catalog |
| `key_transport` | Client ECDH public key, CEKs | Wrapped keys + server EPK | Crypto library |
| `analytics_emitter` | Session events | Async event stream | Message queue |
| `anomaly_detector` | Event stream | Alerts | Rules engine, geo-IP |

### Packaging Tasks (Python/Shell)

| Module | Input | Output | Dependencies |
|--------|-------|--------|-------------|
| `package_asset` | Mezzanine file, asset ID | Encrypted DASH/HLS + manifest | Shaka Packager, KMS client |
| `cdn_upload` | Packaged output directory | CDN-hosted content | S3/GCS SDK |
| `catalog_register` | Asset ID, KID map | Database record | PostgreSQL |

---

## Sources

- [DRM Systems Overview — drmnow.ru](https://drmnow.ru/drm/)
- [Castlabs DRM Guide](https://castlabs.com/drm-guide/)
- [OTTVerse — EME, CDM, AES, CENC, and Keys](https://ottverse.com/eme-cenc-cdm-aes-keys-drm-digital-rights-management/)
- [Unified Streaming — Common Encryption](https://docs.unified-streaming.com/documentation/drm/common-encryption.html)
- [Unified Streaming — Multiple Keys](https://docs.unified-streaming.com/documentation/drm/multiple-keys.html)
- [Unified Streaming — Key Rotation](https://docs.unified-streaming.com/documentation/drm/key-rotation.html)
- [DASH-IF CPIX 2.2 Specification](https://dashif.org/docs/CPIX2.2/Cpix.pdf)
- [PallyCon CPIX API Guide](https://pallycon.com/docs/en/multidrm/packaging/cpix-api/)
- [EZDRM Multi-Key CPIX](https://www.ezdrm.com/solution-multi-key-cpix)
- [Widevine vs PlayReady vs FairPlay Comparison — DoveRunner](https://doverunner.com/blogs/widevine-playready-fairplay-drm-comparison/)
- [DRM Comparison — CopperPod](https://www.copperpodip.com/post/2020/02/25/digital-rights-management-comparing-playready-fairplay-and-widevine)
- [DCI DRM vs Widevine vs FairPlay vs PlayReady — AmpVortex](https://www.ampvortex.com/dci-drm-vs-widevine-fairplay-playready-in-depth-analysis/)
- [OTT Content Security — JScrambler](https://blog.jscrambler.com/keeping-ott-content-secure-tokens-and-drm)
- [Azure Media Services Content Protection](https://learn.microsoft.com/en-us/azure/media-services/latest/drm-content-protection-concept)
- [Axinom — What is DRM](https://portal.axinom.com/mosaic/documentation/drm/what-is-drm)
- [Token-Based URL Authentication — VdoCipher](https://www.vdocipher.com/blog/token-based-urls/)
- [Forensic Watermarking — VdoCipher](https://www.vdocipher.com/blog/forensic-watermarking/)
- [Forensic Watermarking — Castlabs](https://castlabs.com/blog/forensic-watermarking-why-and-how/)
- [Multi-DRM with Forensic Watermarking — Axinom](https://www.axinom.com/article/multi-drm-with-forensic-watermarking)
- [Video Watermarking Explained — Synamedia](https://www.synamedia.com/blog/video-watermarking-explained/)
- [DRM Architecture — Telecom R&D](https://telecom.altanai.com/2025/12/12/digital-rights-management-drm/)
