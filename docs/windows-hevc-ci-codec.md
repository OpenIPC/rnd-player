# Windows HEVC Codec on GitHub Actions CI

## Conclusion (TL;DR)

Edge/Chromium does **not** support software HEVC decode via MSE. It exclusively uses
GPU-based hardware HEVC (DXVA2/D3D11VA). GitHub Actions Windows VMs have no GPU, so
`MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')` always returns
`false` regardless of what codec packages are installed. HEVC playback and filmstrip
tests will skip on Windows/Edge CI until a GPU-enabled runner is available.

The HEVC Video Extensions package **is** installed in CI (from our `ci-assets` release)
and the `--enable-features=PlatformHEVCDecoderSupport` flag is passed to Edge — both
will activate automatically if a run lands on a GPU-enabled runner.

---

## Problem

HEVC tests on `windows-latest / edge` skip because `probeHevcMseSupport` calls
`MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')` in the browser,
which returns `false` on CI runners without a GPU.

## Root Cause

Chromium-based browsers (including Edge) handle HEVC in MSE exclusively via platform
hardware decode (DXVA2/D3D11VA on Windows). There is no software HEVC fallback path in
Chromium for MSE — HEVC is patent-encumbered and Chromium deliberately does not ship a
software HEVC decoder. The HEVC Video Extensions package registers a software Media
Foundation Transform (MFT), but Chromium does not use software MFTs for MSE decode.

On Windows, HEVC in Edge works if and only if:
1. A GPU with HEVC hardware decode capability is present, **and**
2. Hardware acceleration is enabled in the browser

GitHub Actions Windows VMs (both `windows-latest` / Windows Server 2025 and
`windows-2022` / Windows Server 2022) have no GPU → HEVC MSE always fails.

## What We Tried

| Approach | Result |
|----------|--------|
| **AP-W1**: `winget install --source msstore` with product ID `9n4wgh0z6vhq` | `No package found` — Store not accessible on Windows Server VMs |
| **AP-W2**: `store.rg-adguard.net` API to get CDN URL, then `Add-AppxPackage` | API returns HTTP 403 from CI runner IPs (Cloudflare blocks datacenter IPs); self-hosted asset worked around this |
| **AP-W3**: winget with named package string | Not tested separately — root cause identified as Chromium limitation, not a codec install problem |
| **AP-W4**: Chocolatey codec packs (K-Lite, Advanced Codecs) | Irrelevant — these install DirectShow filters, not MFTs. Edge/Chromium MSE uses MFTs, not DirectShow |
| **AP-W5**: `windows-2022` runner | Also no GPU, also skips — dead end |
| **AP-W6**: tmate debug session | Not needed — root cause identified through CI logs |
| **AP-W7**: Accept the limitation | **Current state** — HEVC tests skip on Windows/Edge CI |

## Detailed Investigation Log

| CI Run | Commit | HEVC Playback (Edge) | Notes |
|--------|--------|----------------------|-------|
| 22411917878 | 22fdde8 | **PASSED** | Lucky runner — GPU passthrough on that specific Azure VM |
| 22427593507 | 4a54ec7 | skipped | Install step crashed (em-dash `—` caused PS parse error) |
| 22430367314 | 79932bc | skipped | winget ran; returned "No package found matching input criteria" |
| 22434770678 | a50a10a | skipped | rg-adguard.net returned HTTP 403; windows-2022 also skips |
| 22435846854 | 6aa96ac | skipped | **Codec installed** (`HEVC installed: 2.4.43.0`) but probe still false |
| 22436504853 | 4f175f3 | skipped | `--enable-features=PlatformHEVCDecoderSupport` added — no effect without GPU |
| 22440964659 | 2f15f1f | skipped | **Final state** — all other CI jobs green; HEVC skips accepted |

The one passing run (`22411917878`) had no codec install step at all. It passed because
that specific Azure runner VM happened to have GPU passthrough enabled. The runner pool
is heterogeneous; this cannot be relied upon.

## Current CI State

The following remain in the workflow as passive infrastructure:

**`ci-assets` GitHub release** — hosts the AppxBundle at a stable URL:
```
https://github.com/OpenIPC/rnd-player/releases/download/ci-assets/Microsoft.HEVCVideoExtension_2.4.43.0_neutral_._8wekyb3d8bbwe.AppxBundle
```

**Install step** (`.github/workflows/ci.yml`):
```yaml
- name: Install HEVC Video Extensions (Windows)
  if: runner.os == 'Windows'
  continue-on-error: true
  shell: powershell
  run: |
    $url = "https://github.com/OpenIPC/rnd-player/releases/download/ci-assets/..."
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\hevc.appxbundle" -UseBasicParsing
    Add-AppxPackage -Path "$env:TEMP\hevc.appxbundle" `
      -DependencyPath "https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx"
```

**Playwright Edge launch flag** (`playwright.config.ts`):
```typescript
launchOptions: {
  args: ["--enable-features=PlatformHEVCDecoderSupport"],
},
```

Both are harmless on GPU-less runners and will activate automatically if a GPU-enabled
runner is used.

## If HEVC Testing Becomes a Priority

The only practical path to reliable HEVC testing in Edge CI is a GPU-enabled runner:

- **GitHub Actions larger runners** — GitHub offers GPU runners (e.g. `gpu-8c-56gb-windows-2022`)
  but they require a paid plan and GitHub Team/Enterprise.
- **Self-hosted runner with GPU** — an on-premises or cloud VM with a GPU, registered
  as a self-hosted GitHub Actions runner.
- **Alternative: test HEVC in Chromium on Linux** — Chromium on Linux with VA-API and
  a GPU (or software VA-API via Mesa) may support HEVC decode. Not currently explored.
