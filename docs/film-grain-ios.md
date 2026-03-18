# Film Grain Synthesis PoC -- iOS (SwiftUI + Metal + AVPlayer)

Self-contained implementation specification for porting the web player's real-time film grain overlay to native iOS. All constants, algorithms, and shader logic match the web version exactly (`src/types/filmGrain.ts`, `src/utils/grainTemplate.ts`, `src/hooks/useFilmGrainRenderer.ts`).

---

## 1. Overview

This PoC composites a procedurally generated film grain texture over live video playback on iOS. The grain template is a 512x512 seamlessly-tileable texture generated on-CPU using an autoregressive (AR) Gaussian process with toroidal boundary conditions. A Metal fragment shader samples this texture with `repeat` addressing and blends it with the video frame, scaling intensity by luminance.

**Target platform:** iOS 16+, Apple GPU A8 or later (iPhone 6+, all iPads with Metal).

**No external dependencies.** Pure SwiftUI + Metal + AVFoundation.

---

## 2. Project Structure

```
FilmGrainPoC/
  FilmGrainPoC.xcodeproj
  FilmGrainPoC/
    FilmGrainPoCApp.swift          -- @main entry, WindowGroup
    ContentView.swift               -- URL input, player + controls layout
    Models/
      FilmGrainParams.swift         -- Data model, defaults, @AppStorage keys
    GrainTemplate/
      LFSR16.swift                  -- 16-bit LFSR PRNG
      GrainTemplateGenerator.swift  -- AR process, Box-Muller, toroidal tiling
    Metal/
      FilmGrainShaders.metal        -- MSL vertex + fragment shaders
      GrainRenderer.swift           -- MTKViewDelegate, CVMetalTextureCache, draw calls
    Views/
      PlayerView.swift              -- UIViewRepresentable wrapping MTKView + AVPlayer
      GrainControlsView.swift       -- SwiftUI sliders/pickers/toggles
    Metadata/
      FilmGrainMetadata.swift       -- AV1 OBU film_grain_params() sidecar loader
```

No CocoaPods, SPM packages, or Cartfile. Metal shader file is compiled by Xcode's default Metal build rule.

---

## 3. Architecture

```
AVPlayer
  -> AVPlayerItemVideoOutput (kCVPixelFormatType_32BGRA)
     -> CVPixelBuffer (IOSurface-backed)
        -> CVMetalTextureCache (zero-copy)
           -> MTLTexture (video frame)

GrainTemplateGenerator
  -> [Float] (512x512, values in [-1, 1])
     -> Uint8 encoding: round((val * 0.5 + 0.5) * 255)
        -> MTLTexture (.r8Unorm, repeat addressing, nearest filter)

MTKView (driven by display link)
  -> Metal render pass
     -> Vertex shader: fullscreen quad
     -> Fragment shader: sample video + grain, luminance ramp, blend
        -> Drawable presentation
```

Key design decisions:
- **Zero-copy video frames** via `CVMetalTextureCache` -- no `MTLTexture.replace()` copies.
- **Triple buffering** with 3 in-flight command buffers (semaphore-gated).
- **Grain texture uploaded once** per size change (not per frame).
- **Frame offset** derived from splitmix32 hash of frame counter (incremented per new video frame).

---

## 4. Shared Algorithm: Grain Template Generation

### 4.1 FilmGrainParams.swift

```swift
import Foundation

enum GrainSize: String, CaseIterable, Identifiable {
    case fine, medium, coarse
    var id: String { rawValue }

    /// AR lag: fine=0 (white noise), medium=1 (3x3), coarse=2 (5x5)
    var arLag: Int {
        switch self {
        case .fine:   return 0
        case .medium: return 1
        case .coarse: return 2
        }
    }
}

enum GrainBlendMode: String, CaseIterable, Identifiable {
    case additive, multiplicative
    var id: String { rawValue }
}

struct FilmGrainParams {
    var intensity: Double = 50      // 0-100, maps to sigma 0.0-0.15
    var size: GrainSize = .medium
    var chromatic: Bool = false      // false = mono, true = independent per-channel
    var blendMode: GrainBlendMode = .additive
}
```

### 4.2 LFSR16.swift

```swift
/// 16-bit LFSR PRNG matching AV1 spec: x^16 + x^15 + x^13 + x^4 + 1
struct LFSR16 {
    private var state: UInt16

    init(seed: UInt16 = 7391) {
        state = seed == 0 ? 0xACE1 : seed
    }

    mutating func next() -> UInt16 {
        let s = state
        let bit: UInt16 = ((s >> 0) ^ (s >> 1) ^ (s >> 3) ^ (s >> 12)) & 1
        state = ((s >> 1) | (bit << 15)) & 0xFFFF
        return state
    }
}
```

### 4.3 GrainTemplateGenerator.swift

```swift
import Foundation

/// Texture dimensions -- large enough that tiling is not visible at 1080p
let grainTextureSize = 512

/// AR coefficients for lag 1: 3x3 kernel, 4 causal neighbors, sum = 0.40
/// Layout: rows 0..1, cols 0..2. Center is [1][1] (current pixel).
/// Only causal entries (above current row, or same row left of center) are used.
private let arCoeffsLag1: [[Float]] = [
    [0.0,  0.20, 0.0],
    [0.20, 0.0,  0.0],
]

/// AR coefficients for lag 2: 5x5 kernel, 12 causal neighbors, sum ~= 0.71
/// Layout: rows 0..2, cols 0..4. Center is [2][2].
private let arCoeffsLag2: [[Float]] = [
    [0.00, 0.03, 0.06, 0.03, 0.00],
    [0.03, 0.09, 0.16, 0.09, 0.00],
    [0.06, 0.16, 0.00, 0.00, 0.00],
]

/// Box-Muller transform: standard normal from uniform LFSR values.
private func gaussianFromLfsr(_ rng: inout LFSR16) -> Float {
    let u1 = (Float(rng.next()) + 1.0) / 65537.0   // avoid log(0)
    let u2 = Float(rng.next()) / 65536.0
    return sqrtf(-2.0 * logf(u1)) * cosf(2.0 * .pi * u2)
}

/// Generate a 512x512 seamlessly-tileable grain texture.
/// Returns Float array of size grainTextureSize^2 with values in [-1, 1].
func generateGrainTemplate(size: GrainSize, seed: UInt16 = 7391) -> [Float] {
    let N = grainTextureSize
    let count = N * N
    var rng = LFSR16(seed: seed)
    var template = [Float](repeating: 0, count: count)
    let lag = size.arLag

    if lag == 0 {
        // Pure white noise -- no spatial correlation
        for i in 0..<count {
            template[i] = gaussianFromLfsr(&rng)
        }
    } else {
        // Fill innovation noise
        var noise = [Float](repeating: 0, count: count)
        for i in 0..<count {
            noise[i] = gaussianFromLfsr(&rng)
        }

        let coeffs: [[Float]] = lag == 1 ? arCoeffsLag1 : arCoeffsLag2
        let kH = coeffs.count
        let kW = coeffs[0].count
        let kCenterX = kW / 2
        let kCenterY = kH - 1

        // Two passes: pass 2 sees AR-filtered values from pass 1 when wrapping
        for _ in 0..<2 {
            for y in 0..<N {
                for x in 0..<N {
                    var sum: Float = 0

                    for ky in 0..<kH {
                        for kx in 0..<kW {
                            let coeff = coeffs[ky][kx]
                            if coeff == 0 { continue }

                            let dy = ky - kCenterY
                            let dx = kx - kCenterX

                            // Only causal pixels: above current row, or same row to the left
                            if dy > 0 || (dy == 0 && dx >= 0) { continue }

                            // Toroidal wrapping
                            let ny = ((y + dy) % N + N) % N
                            let nx = ((x + dx) % N + N) % N

                            sum += coeff * template[ny * N + nx]
                        }
                    }

                    template[y * N + x] = sum + noise[y * N + x]
                }
            }
        }
    }

    // Sigma-clipping normalization: center, clip to +/-3 sigma, scale to [-1, 1]
    var mean: Float = 0
    for i in 0..<count { mean += template[i] }
    mean /= Float(count)
    for i in 0..<count { template[i] -= mean }

    var sumSq: Float = 0
    for i in 0..<count { sumSq += template[i] * template[i] }
    let sigma = sqrtf(sumSq / Float(count))

    if sigma > 0 {
        let clip = 3.0 * sigma
        let scale = 1.0 / clip
        for i in 0..<count {
            template[i] = max(-1, min(1, template[i] * scale))
        }
    }

    return template
}

/// Encode [-1,1] float template to [0,255] UInt8 for R8 texture upload.
/// Shader decodes: val * 2.0 - 1.0
func encodeGrainTemplateR8(_ template: [Float]) -> [UInt8] {
    template.map { UInt8(clamping: Int(roundf(($0 * 0.5 + 0.5) * 255.0))) }
}
```

---

## 5. Metal Shading Language Port

### 5.1 FilmGrainShaders.metal

```metal
#include <metal_stdlib>
using namespace metal;

// ---- Uniform struct (must match Swift GrainUniforms layout) ----

struct GrainUniforms {
    float intensity;     // (params.intensity / 100) * 0.15
    float grainSize;     // always 512.0
    float2 frameOffset;  // splitmix32 hash of frame counter, split into two [0,1) floats
    int blendMode;       // 0 = additive, 1 = multiplicative
    int chromatic;       // 0 = mono, 1 = per-channel
    float2 resolution;   // viewport size in pixels
};

// ---- Vertex ----

struct VertexOut {
    float4 position [[position]];
    float2 texCoord;
};

vertex VertexOut filmGrainVertex(uint vertexID [[vertex_id]]) {
    // Fullscreen quad: 6 vertices (2 triangles, triangle list)
    constexpr float2 positions[] = {
        {-1, -1}, { 1, -1}, {-1,  1},
        {-1,  1}, { 1, -1}, { 1,  1},
    };

    VertexOut out;
    float2 pos = positions[vertexID];
    out.position = float4(pos, 0.0, 1.0);
    // Flip Y: Metal texture origin is top-left, video is top-left
    out.texCoord = float2(pos.x * 0.5 + 0.5, 1.0 - (pos.y * 0.5 + 0.5));
    return out;
}

// ---- Fragment uniforms ----

struct GrainUniforms {
    float intensity;     // (params.intensity / 100) * 0.15
    float grainSize;     // always 512.0
    float2 frameOffset;  // splitmix32 hash of frame counter, split into two [0,1) floats
    int blendMode;       // 0 = additive, 1 = multiplicative
    int chromatic;       // 0 = mono, 1 = per-channel
    float2 resolution;   // viewport size in pixels
};

// ---- Fragment ----

fragment half4 filmGrainFragment(
    VertexOut in [[stage_in]],
    texture2d<half> videoTexture [[texture(0)]],
    texture2d<half> grainTexture [[texture(1)]],
    constant GrainUniforms &u [[buffer(0)]]
) {
    constexpr sampler videoSampler(filter::linear, address::clamp_to_edge);
    constexpr sampler grainSampler(filter::nearest, address::repeat);

    half4 vid = videoTexture.sample(videoSampler, in.texCoord);
    float2 px = in.texCoord * u.resolution;
    float2 grainUV = px / u.grainSize + u.frameOffset;

    // Sample grain (R8 texture stores [0,1], decode to [-1,1])
    half gR = grainTexture.sample(grainSampler, grainUV).r * 2.0h - 1.0h;
    half gG = gR;
    half gB = gR;

    if (u.chromatic == 1) {
        // Golden-ratio-based offsets for decorrelated channels
        gG = grainTexture.sample(grainSampler, grainUV + float2(0.6180, 0.3819)).r * 2.0h - 1.0h;
        gB = grainTexture.sample(grainSampler, grainUV + float2(0.3819, 0.7236)).r * 2.0h - 1.0h;
    }

    // Luminance-dependent intensity scaling (BT.601)
    half luma = dot(vid.rgb, half3(0.299h, 0.587h, 0.114h));
    half sc = half(u.intensity);
    if (luma < 0.15h) {
        sc *= luma / 0.15h;
    } else if (luma > 0.85h) {
        sc *= (1.0h - luma) / 0.15h;
    }

    half3 g = half3(gR, gG, gB) * sc;
    half3 res;
    if (u.blendMode == 1) {
        res = vid.rgb * (1.0h + g);   // multiplicative
    } else {
        res = vid.rgb + g;             // additive
    }

    return half4(clamp(res, 0.0h, 1.0h), 1.0h);
}
```

### 5.2 Key differences from GLSL

| GLSL (WebGL2)                          | MSL (Metal)                                    |
|-----------------------------------------|-----------------------------------------------|
| `#version 300 es`                       | `#include <metal_stdlib>`                      |
| `uniform sampler2D u_video`             | `texture2d<half> videoTexture [[texture(0)]]`  |
| `uniform float u_intensity`             | `constant GrainUniforms &u [[buffer(0)]]`      |
| `texture(sampler, uv)`                  | `texture.sample(sampler, uv)`                  |
| Sampler state set via `gl.texParameteri`| `constexpr sampler(filter::, address::)`       |
| `precision highp float`                 | `half` (16-bit) for GPU perf, `float` for UV   |
| `gl_Position`, `out vec4 fragColor`     | `[[position]]`, return `half4`                 |

---

## 6. GrainRenderer.swift

```swift
import MetalKit
import AVFoundation
import CoreVideo

final class GrainRenderer: NSObject, MTKViewDelegate {

    // MARK: - Metal state

    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLRenderPipelineState
    private var textureCache: CVMetalTextureCache?
    private var grainTexture: MTLTexture?

    // MARK: - AV state

    private let player: AVPlayer
    private let videoOutput: AVPlayerItemVideoOutput

    // MARK: - Triple buffering

    private let inflightSemaphore = DispatchSemaphore(value: 3)

    // MARK: - Cached video texture (reused when paused)

    private var lastVideoTexture: MTLTexture?
    private var lastVideoWidth: Float = 0
    private var lastVideoHeight: Float = 0

    // MARK: - Params

    var grainParams = FilmGrainParams() {
        didSet {
            if oldValue.size != grainParams.size {
                uploadGrainTexture(size: grainParams.size)
            }
        }
    }

    // Track current grain size to avoid redundant uploads
    private var currentGrainSize: GrainSize?

    // Frame counter for hash-based grain offset (incremented per new video frame)
    private var frameCount: UInt32 = 0

    // MARK: - Init

    init?(device: MTLDevice, player: AVPlayer) {
        guard let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.commandQueue = queue
        self.player = player

        // Video output: BGRA for Metal compatibility
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        self.videoOutput = AVPlayerItemVideoOutput(pixelBufferAttributes: attrs)

        // Pipeline
        guard let library = device.makeDefaultLibrary(),
              let vertFunc = library.makeFunction(name: "filmGrainVertex"),
              let fragFunc = library.makeFunction(name: "filmGrainFragment")
        else { return nil }

        let desc = MTLRenderPipelineDescriptor()
        desc.vertexFunction = vertFunc
        desc.fragmentFunction = fragFunc
        desc.colorAttachments[0].pixelFormat = .bgra8Unorm

        do {
            self.pipelineState = try device.makeRenderPipelineState(descriptor: desc)
        } catch {
            print("Failed to create pipeline state: \(error)")
            return nil
        }

        // Texture cache for zero-copy CVPixelBuffer -> MTLTexture
        var cache: CVMetalTextureCache?
        CVMetalTextureCacheCreate(nil, nil, device, nil, &cache)
        self.textureCache = cache

        super.init()
    }

    /// Call after AVPlayerItem is ready. Attaches the video output.
    func attachToPlayerItem() {
        guard let item = player.currentItem else { return }
        if !item.outputs.contains(videoOutput) {
            item.add(videoOutput)
        }
        // Initial grain texture upload
        uploadGrainTexture(size: grainParams.size)
    }

    // MARK: - Grain texture upload

    private func uploadGrainTexture(size: GrainSize) {
        guard currentGrainSize != size else { return }
        currentGrainSize = size

        let template = generateGrainTemplate(size: size, seed: 7391)
        let r8Data = encodeGrainTemplateR8(template)

        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r8Unorm,
            width: grainTextureSize,
            height: grainTextureSize,
            mipmapped: false
        )
        desc.usage = [.shaderRead]
        desc.storageMode = .shared   // iOS uses shared memory

        guard let tex = device.makeTexture(descriptor: desc) else { return }
        r8Data.withUnsafeBytes { ptr in
            tex.replace(
                region: MTLRegionMake2D(0, 0, grainTextureSize, grainTextureSize),
                mipmapLevel: 0,
                withBytes: ptr.baseAddress!,
                bytesPerRow: grainTextureSize
            )
        }
        grainTexture = tex
    }

    // MARK: - MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
        // No-op; viewport computed each frame
    }

    func draw(in view: MTKView) {
        // Update cached video texture if a new frame is available.
        // Do this BEFORE requesting the drawable to avoid draining the
        // drawable pool when paused (no new pixel buffers).
        let itemTime = videoOutput.itemTime(forHostTime: CACurrentMediaTime())
        if videoOutput.hasNewPixelBuffer(forItemTime: itemTime),
           let pixelBuffer = videoOutput.copyPixelBuffer(forItemTime: itemTime,
                                                         itemTimeForDisplay: nil),
           let videoTex = metalTexture(from: pixelBuffer) {
            lastVideoTexture = videoTex
            lastVideoWidth = Float(CVPixelBufferGetWidth(pixelBuffer))
            lastVideoHeight = Float(CVPixelBufferGetHeight(pixelBuffer))
            frameCount &+= 1
        }

        // Need both a cached video frame and a grain texture to render
        guard let videoTex = lastVideoTexture,
              let grainTex = grainTexture
        else { return }

        inflightSemaphore.wait()

        guard let drawable = view.currentDrawable,
              let rpd = view.currentRenderPassDescriptor
        else {
            inflightSemaphore.signal()
            return
        }

        // Compute letterbox viewport
        let drawW = Float(view.drawableSize.width)
        let drawH = Float(view.drawableSize.height)
        let vidW = lastVideoWidth
        let vidH = lastVideoHeight

        var vpX: Float = 0, vpY: Float = 0, vpW = drawW, vpH = drawH
        if vidW > 0 && vidH > 0 {
            let videoAspect = vidW / vidH
            let canvasAspect = drawW / drawH
            if videoAspect > canvasAspect {
                vpH = drawW / videoAspect
                vpY = (drawH - vpH) / 2
            } else if videoAspect < canvasAspect {
                vpW = drawH * videoAspect
                vpX = (drawW - vpW) / 2
            }
        }

        // Build uniforms
        let h = grainHash(frameCount)
        let offsetX = Float(h & 0xFFFF) / 65536.0
        let offsetY = Float((h >> 16) & 0xFFFF) / 65536.0
        var uniforms = GrainUniforms(
            intensity: Float(grainParams.intensity / 100.0) * 0.15,
            grainSize: Float(grainTextureSize),
            frameOffset: SIMD2<Float>(offsetX, offsetY),
            blendMode: Int32(grainParams.blendMode == .multiplicative ? 1 : 0),
            chromatic: Int32(grainParams.chromatic ? 1 : 0),
            resolution: SIMD2<Float>(vpW, vpH)
        )

        // Encode
        guard let cmdBuf = commandQueue.makeCommandBuffer(),
              let encoder = cmdBuf.makeRenderCommandEncoder(descriptor: rpd)
        else {
            inflightSemaphore.signal()
            return
        }

        // Clear to black, then set letterbox viewport
        encoder.setViewport(MTLViewport(
            originX: Double(vpX), originY: Double(vpY),
            width: Double(vpW), height: Double(vpH),
            znear: 0, zfar: 1
        ))

        encoder.setRenderPipelineState(pipelineState)
        encoder.setFragmentTexture(videoTex, index: 0)
        encoder.setFragmentTexture(grainTex, index: 1)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<GrainUniforms>.size, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
        encoder.endEncoding()

        cmdBuf.present(drawable)
        cmdBuf.addCompletedHandler { [weak self] _ in
            self?.inflightSemaphore.signal()
        }
        cmdBuf.commit()
    }

    // MARK: - CVPixelBuffer -> MTLTexture (zero-copy)

    private func metalTexture(from pixelBuffer: CVPixelBuffer) -> MTLTexture? {
        guard let cache = textureCache else { return nil }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)

        var cvTexture: CVMetalTexture?
        let status = CVMetalTextureCacheCreateTextureFromImage(
            nil, cache, pixelBuffer, nil,
            .bgra8Unorm, width, height, 0, &cvTexture
        )
        guard status == kCVReturnSuccess, let cvTex = cvTexture else { return nil }
        return CVMetalTextureGetTexture(cvTex)
    }
}

// MARK: - Uniform struct (must match MSL layout)

struct GrainUniforms {
    var intensity: Float           // offset 0
    var grainSize: Float           // offset 4
    var frameOffset: SIMD2<Float>  // offset 8  (aligned to 8)
    var blendMode: Int32           // offset 16
    var chromatic: Int32           // offset 20
    var resolution: SIMD2<Float>   // offset 24 (aligned to 8)
    // total: 32 bytes
}

// MARK: - Helpers

/// splitmix32 hash for pseudo-random grain offset per frame
private func grainHash(_ x: UInt32) -> UInt32 {
    var z = x &+ 0x9E3779B9
    z = (z ^ (z >> 15)) &* 0x85EBCA6B
    z = (z ^ (z >> 13)) &* 0xC2B2AE35
    return z ^ (z >> 16)
}
```

### 6.1 Zero-copy pipeline explained

`CVMetalTextureCacheCreateTextureFromImage` wraps the `CVPixelBuffer`'s backing `IOSurface` as an `MTLTexture` without any GPU-side or CPU-side copy. The texture is valid only for the current frame's command buffer lifetime. This is the same mechanism `AVSampleBufferDisplayLayer` uses internally.

### 6.2 Triple buffering

The `DispatchSemaphore(value: 3)` allows up to 3 frames in flight (CPU encoding frame N+2 while GPU renders N+1 and display scans N). `wait()` at frame start, `signal()` in `addCompletedHandler`. This prevents runaway CPU encoding from outpacing the GPU.

---

## 7. SwiftUI Integration

### 7.1 PlayerView.swift (UIViewRepresentable)

```swift
import SwiftUI
import MetalKit
import AVFoundation

struct PlayerView: UIViewRepresentable {
    let player: AVPlayer
    @Binding var grainParams: FilmGrainParams

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> MTKView {
        guard let device = MTLCreateSystemDefaultDevice() else {
            fatalError("Metal is not supported on this device")
        }

        let mtkView = MTKView(frame: .zero, device: device)
        mtkView.colorPixelFormat = .bgra8Unorm
        mtkView.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        mtkView.isPaused = false
        mtkView.enableSetNeedsDisplay = false
        mtkView.preferredFramesPerSecond = 60
        // Let Auto Layout size the view; drawable size follows
        mtkView.autoResizeDrawable = true
        mtkView.contentMode = .scaleAspectFit

        guard let renderer = GrainRenderer(device: device, player: player) else {
            fatalError("Failed to create GrainRenderer")
        }
        renderer.grainParams = grainParams
        mtkView.delegate = renderer
        context.coordinator.renderer = renderer

        // Observe playerItem readiness to attach video output
        context.coordinator.observePlayerItem(player: player)

        return mtkView
    }

    func updateUIView(_ uiView: MTKView, context: Context) {
        context.coordinator.renderer?.grainParams = grainParams
    }

    class Coordinator {
        var renderer: GrainRenderer?
        private var itemObservation: NSKeyValueObservation?

        func observePlayerItem(player: AVPlayer) {
            itemObservation = player.observe(\.currentItem?.status) { [weak self] player, _ in
                if player.currentItem?.status == .readyToPlay {
                    DispatchQueue.main.async {
                        self?.renderer?.attachToPlayerItem()
                    }
                }
            }
        }
    }
}
```

### 7.2 ContentView.swift

```swift
import SwiftUI
import AVFoundation

struct ContentView: View {
    @State private var player = AVPlayer()
    @State private var grainParams = FilmGrainParams()
    @State private var urlString = ""

    // Persist params across launches
    @AppStorage("grain_intensity") private var savedIntensity: Double = 50
    @AppStorage("grain_size") private var savedSize: String = "medium"
    @AppStorage("grain_chromatic") private var savedChromatic: Bool = false
    @AppStorage("grain_blendMode") private var savedBlendMode: String = "additive"

    var body: some View {
        VStack(spacing: 0) {
            PlayerView(player: player, grainParams: $grainParams)
                .ignoresSafeArea()

            // URL input
            HStack {
                TextField("Enter stream URL", text: $urlString)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .onSubmit { loadURL() }
                Button("Load") { loadURL() }
            }
            .padding(.horizontal)
            .padding(.top, 8)

            GrainControlsView(params: $grainParams)
                .padding()
        }
        .onAppear {
            restoreParams()
        }
        .onChange(of: grainParams.intensity) { _, v in savedIntensity = v }
        .onChange(of: grainParams.size) { _, v in savedSize = v.rawValue }
        .onChange(of: grainParams.chromatic) { _, v in savedChromatic = v }
        .onChange(of: grainParams.blendMode) { _, v in savedBlendMode = v.rawValue }
    }

    private func restoreParams() {
        grainParams.intensity = savedIntensity
        grainParams.size = GrainSize(rawValue: savedSize) ?? .medium
        grainParams.chromatic = savedChromatic
        grainParams.blendMode = GrainBlendMode(rawValue: savedBlendMode) ?? .additive
    }

    private func loadURL() {
        guard let url = URL(string: urlString) else { return }
        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        player.play()
    }
}
```

---

## 8. AV1 SEI / Film Grain Metadata

AV1 bitstreams can carry per-frame `film_grain_params()` in the sequence header OBU or frame header OBU (spec section 6.8.20). These parameters include:
- `grain_seed` (16-bit)
- `num_y_points`, `num_cb_points`, `num_cr_points` (intensity mapping curve)
- `ar_coeff_lag` (0, 1, 2, or 3)
- `ar_coeffs_y_plus_128[]`, `ar_coeffs_cb_plus_128[]`, `ar_coeffs_cr_plus_128[]`
- `grain_scale_shift`, `cb_mult`, `cb_luma_mult`, `cb_offset`
- `overlap_flag`, `clip_to_restricted_range`

### 8.1 PoC approach: sidecar JSON

For the PoC, parsing raw OBUs from `CMSampleBuffer` is complex. Use a sidecar JSON file with pre-extracted grain metadata:

```swift
struct AV1GrainMetadata: Codable {
    let grainSeed: UInt16
    let arCoeffLag: Int               // 0, 1, 2, or 3
    let arCoeffsY: [Int]              // values are coeff + 128
    let numYPoints: Int
    let pointsY: [[Int]]             // [[value, scaling], ...]
    let grainScaleShift: Int
    let overlapFlag: Bool
    let clipToRestrictedRange: Bool
}

/// Load sidecar JSON (bundled or fetched alongside manifest)
func loadFilmGrainMetadata(from url: URL) async throws -> [AV1GrainMetadata] {
    let (data, _) = try await URLSession.shared.data(from: url)
    return try JSONDecoder().decode([AV1GrainMetadata].self, from: data)
}
```

### 8.2 Mapping AV1 params to FilmGrainParams

For the PoC, the mapping is simplified:

| AV1 field          | FilmGrainParams field | Mapping                                |
|--------------------|-----------------------|----------------------------------------|
| `ar_coeff_lag`     | `size`                | 0->fine, 1->medium, 2->coarse, 3->coarse |
| `grain_scale_shift`| `intensity`           | `100 * (1.0 / (1 << shift)) / 0.15`   |
| `grain_seed`       | seed param            | Pass directly to LFSR16                |
| N/A (always mono in AV1 Y plane) | `chromatic` | Set from `num_cb_points > 0`        |

### 8.3 Future: AVAssetReader OBU parsing

A production implementation would use `AVAssetReaderTrackOutput` with `kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms` to access the `av1C` config record and per-frame OBU data from `CMSampleBuffer` `CMBlockBuffer` payloads. This requires parsing the OBU header (type 6 = frame header) and extracting `film_grain_params()` bitfields per AV1 spec.

---

## 9. UI Controls

### GrainControlsView.swift

```swift
import SwiftUI

struct GrainControlsView: View {
    @Binding var params: FilmGrainParams

    var body: some View {
        VStack(spacing: 12) {
            // Intensity slider: 0-100
            HStack {
                Text("Intensity")
                    .frame(width: 80, alignment: .leading)
                Slider(value: $params.intensity, in: 0...100, step: 1)
                Text("\(Int(params.intensity))")
                    .monospacedDigit()
                    .frame(width: 36, alignment: .trailing)
            }

            // Grain size picker
            HStack {
                Text("Size")
                    .frame(width: 80, alignment: .leading)
                Picker("", selection: $params.size) {
                    ForEach(GrainSize.allCases) { size in
                        Text(size.rawValue.capitalized).tag(size)
                    }
                }
                .pickerStyle(.segmented)
            }

            // Blend mode picker
            HStack {
                Text("Blend")
                    .frame(width: 80, alignment: .leading)
                Picker("", selection: $params.blendMode) {
                    ForEach(GrainBlendMode.allCases) { mode in
                        Text(mode.rawValue.capitalized).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
            }

            // Chromatic toggle
            Toggle("Chromatic grain", isOn: $params.chromatic)
        }
        .padding()
        .background(.ultraThinMaterial)
        .cornerRadius(12)
    }
}
```

---

## 10. Performance

### Expected frame times

| Operation                            | Time (A12+)   | Time (A8-A11) |
|--------------------------------------|---------------|---------------|
| CVMetalTextureCache lookup           | ~0.01ms       | ~0.01ms       |
| Fragment shader (1080p)              | ~0.1-0.2ms    | ~0.3-0.5ms    |
| Fragment shader (4K)                 | ~0.3-0.5ms    | ~0.8-1.2ms    |
| Grain template generation (CPU)     | ~3-8ms        | ~5-15ms       |
| Grain texture upload (512x512 R8)   | ~0.05ms       | ~0.1ms        |

The fragment shader cost is dominated by 1-3 texture samples (mono vs chromatic). At 1080p, the grain overlay adds less than 0.3ms to the frame -- well within the 16.6ms budget for 60fps.

### Zero-copy benefits

Without `CVMetalTextureCache`, each frame would require `CVPixelBufferLockBaseAddress` + `MTLTexture.replace(region:)` -- a full CPU-side copy of the frame (~3ms for 1080p BGRA). The IOSurface-backed zero-copy path eliminates this entirely.

### Memory

- Grain texture: 512 * 512 * 1 byte = 256 KB (R8)
- Video texture: zero additional allocation (IOSurface shared)
- Template generation buffer: 512 * 512 * 4 bytes = 1 MB (transient, freed after upload)

---

## 11. Limitations

### DRM content (FairPlay)

`AVPlayerItemVideoOutput.copyPixelBuffer(forItemTime:)` returns `nil` for FairPlay-protected content. The `CVPixelBuffer` is not available because the decryption occurs in a hardware-isolated pipeline that does not expose decoded frames to userspace.

**Workaround for PoC:** Test with unprotected HLS/MP4 content only. A production DRM-compatible path would require `AVSampleBufferDisplayLayer` with a custom `CAMetalLayer` compositor, which is significantly more complex and not covered here.

### No hardware grain synthesis

Unlike AV1 hardware decoders that can apply `film_grain_params()` during decode (supported in the AV1 spec as a post-decode filter), this PoC applies grain as a post-composition overlay. The visual result is equivalent, but the hardware path (when available) would be more power-efficient.

### Texture tiling visibility

At resolutions above 2160p on very large displays, the 512x512 tile may become perceptible. The web version uses the same 512px size. For iOS devices (max 2778x1284 on iPhone, 2732x2048 on iPad), this is not an issue.

### Color space

The shader uses BT.601 luma coefficients (`0.299, 0.587, 0.114`) matching the web version. For HDR/BT.2020 content, these would need updating to `(0.2627, 0.6780, 0.0593)`. The PoC does not handle HDR or wide color gamut.

---

## 12. Implementation Phases

### Phase 1: Metal rendering pipeline (days 1-2)

1. Create Xcode project with SwiftUI lifecycle, no storyboards.
2. Implement `GrainRenderer` with hardcoded white noise texture (skip AR process).
3. Wire up `MTKView` via `UIViewRepresentable`, verify video frame display.
4. Confirm zero-copy `CVMetalTextureCache` path works (check `copyPixelBuffer` is non-nil).
5. Verify letterbox viewport calculation with various aspect ratios.

**Milestone:** Video plays through Metal with no grain -- visually identical to native playback.

### Phase 2: Grain template + shader (days 3-4)

1. Port `LFSR16`, `GrainTemplateGenerator` from web version.
2. Validate: generate template in Swift, compare byte-for-byte against TypeScript output for seed=7391, all three sizes. Write a unit test that checks the first 64 values match.
3. Implement MSL fragment shader with all blend modes and chromatic support.
4. Upload R8 grain texture, verify tiling with `repeat` sampler addressing.
5. Verify frame offset animation produces smooth temporal variation.

**Milestone:** Grain overlay matches web player output for all parameter combinations.

### Phase 3: UI controls + persistence (day 5)

1. Build `GrainControlsView` with sliders, segmented pickers, toggle.
2. Wire `@AppStorage` persistence for all four parameters.
3. Add URL text field for loading arbitrary HLS/MP4 streams.
4. Add play/pause button.

**Milestone:** Fully interactive PoC with persisted settings.

### Phase 4: AV1 metadata (stretch goal, days 6-7)

1. Implement sidecar JSON loader for `AV1GrainMetadata`.
2. Map AV1 `ar_coeff_lag` and `grain_scale_shift` to `FilmGrainParams`.
3. Per-frame seed variation from `grain_seed` field.
4. Document path toward `AVAssetReader` OBU parsing for production.

**Milestone:** Grain parameters driven by AV1 metadata sidecar.

---

## Appendix A: Constant Reference

All constants below must match the web implementation exactly.

| Constant                     | Value                              | Source file              |
|-----------------------------|------------------------------------|--------------------------|
| Grain texture size           | 512                                | `grainTemplate.ts:11`   |
| LFSR polynomial              | x^16 + x^15 + x^13 + x^4 + 1     | `grainTemplate.ts:22`   |
| LFSR default seed (zero)     | 0xACE1                             | `grainTemplate.ts:24`   |
| Default seed parameter       | 7391                               | `grainTemplate.ts:65`   |
| LFSR step                    | `bit = (s>>0 ^ s>>1 ^ s>>3 ^ s>>12) & 1; state = (s>>1 \| bit<<15) & 0xFFFF` | `grainTemplate.ts:27-28` |
| Box-Muller u1                | `(rng() + 1) / 65537`             | `grainTemplate.ts:37`   |
| Box-Muller u2                | `rng() / 65536`                    | `grainTemplate.ts:38`   |
| AR lag fine                  | 0                                  | `grainTemplate.ts:14`   |
| AR lag medium                | 1                                  | `grainTemplate.ts:15`   |
| AR lag coarse                | 2                                  | `grainTemplate.ts:16`   |
| AR lag 1 coeffs (3x3)       | `[[0,0.20,0],[0.20,0,0]]`         | `grainTemplate.ts:47-50`|
| AR lag 2 coeffs (5x5)       | `[[0,0.03,0.06,0.03,0],[0.03,0.09,0.16,0.09,0],[0.06,0.16,0,0,0]]` | `grainTemplate.ts:52-56` |
| AR passes                   | 2                                  | `grainTemplate.ts:91`   |
| Sigma clip                  | 3 sigma                            | `grainTemplate.ts:133`  |
| R8 encoding                 | `round((val * 0.5 + 0.5) * 255)`  | `useFilmGrainRenderer.ts:234` |
| Intensity mapping            | `(params.intensity / 100) * 0.15`  | `useFilmGrainRenderer.ts:335` |
| Frame offset algorithm       | splitmix32 hash of frame counter   | `GrainRenderer.swift`, `useFilmGrainRenderer.ts` |
| Chromatic green offset       | (0.6180, 0.3819)                   | `useFilmGrainRenderer.ts:55` |
| Chromatic blue offset        | (0.3819, 0.7236)                   | `useFilmGrainRenderer.ts:56` |
| Luma coefficients (BT.601)  | (0.299, 0.587, 0.114)             | `useFilmGrainRenderer.ts:59` |
| Luma dark threshold          | 0.15                               | `useFilmGrainRenderer.ts:61` |
| Luma bright threshold        | 0.85                               | `useFilmGrainRenderer.ts:62` |
| Blend additive               | `vid.rgb + g`                      | `useFilmGrainRenderer.ts:69` |
| Blend multiplicative         | `vid.rgb * (1 + g)`               | `useFilmGrainRenderer.ts:67` |
