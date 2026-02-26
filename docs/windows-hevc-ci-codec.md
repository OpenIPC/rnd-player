# Windows HEVC Codec on GitHub Actions CI

## Problem

HEVC filmstrip and playback tests on the `windows-latest / edge` CI matrix entry skip
because `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')` returns
`false` on most GitHub Actions Windows runner instances. Without a GPU and without the
HEVC codec package, Windows Server has no HEVC decode capability — Edge reflects this
in its MSE type-support query.

The HEVC Video Extensions (either the $0.99 paid version or the free "from Device
Manufacturer" variant, app ID `9n4wgh0z6vhq`) provides the missing software HEVC
decoder via Media Foundation. With it installed, both `isTypeSupported` and WebCodecs
`VideoDecoder.isConfigSupported` return true, enabling both the playback and filmstrip
test suites.

## What We Observed

| CI Run | Commit | HEVC Playback (Edge) | HEVC Filmstrip (Edge) | Notes |
|--------|--------|----------------------|-----------------------|-------|
| 22411917878 | 22fdde8 | **PASSED** | skipped | Lucky runner — had HEVC pre-installed |
| 22427593507 | 4a54ec7 | skipped | skipped | Install step crashed (PS encoding bug) |
| 22430367314 | 79932bc | skipped | skipped | Install step ran; winget returned "No package found" |

Run `22411917878` is the only successful HEVC playback run. It had no codec install
step at all — that runner happened to have HEVC support already (different VM image
revision, pre-installed codec, or hardware decode available on that specific host).
All subsequent runners do not have it, and the behaviour is not reproducible.

## What We Tried

### AP-W1: winget `--source msstore` (failed)

```yaml
- name: Install HEVC Video Extensions (Windows)
  if: matrix.os == 'windows-latest'
  continue-on-error: true
  shell: powershell
  run: |
    winget install `
      --id 9n4wgh0z6vhq `
      --source msstore `
      --accept-source-agreements `
      --accept-package-agreements `
      --silent
```

**First attempt** (commit `4a54ec7`): PowerShell parse error — the em-dash `—` in a
`Write-Host` string caused `TerminatorExpectedAtEndOfString`. Script exited before
winget ran.

**Second attempt** (commit `79932bc`): Encoding fixed. winget ran and printed:

```
No package found matching input criteria.
```

Root cause: `9n4wgh0z6vhq` is a Microsoft Store *product ID*. winget's `msstore`
source uses a different namespace and apparently cannot resolve this ID on Windows
Server 2025 VMs. The Microsoft Store front-end is either not accessible or not
configured on GitHub Actions runners.

## Why `probeHevcMseSupport` Is Inconsistent

The probe calls `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')`.
On Windows, this delegates to Media Foundation. HEVC decoding in MF requires one of:

1. **Hardware decode** — GPU driver exposes an HEVC MFT. GitHub Actions VMs are
   headless; there is no GPU or GPU driver → unavailable.
2. **Software decode via HEVC Video Extensions** — the codec package registers a
   software MFT. Not pre-installed on all runner images.
3. **Built-in software decode** — Windows 11 24H2+ includes HEVC decode in-box, but
   GitHub Actions uses Windows Server 2025 which may not have this.

The one lucky runner (run `22411917878`) likely had the codec pre-installed from a
different image build, or was a Windows 11 host with built-in HEVC. The pool is
heterogeneous.

## Proposed Action Items

These are independent and can be investigated in parallel.

### AP-W2: Try `Add-AppxPackage` with a direct Microsoft CDN URL

The HEVC Video Extensions from Device Manufacturer AppxBundle is served from
Microsoft's CDN. The URL can be obtained by querying
`https://store.rg-adguard.net/api/GetFiles` with the Store product URL. If a stable
CDN URL exists, `Add-AppxPackage` bypasses winget's Store resolution entirely.

```powershell
# Possible approach (URL must be verified first):
$url = "https://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/..."
$dest = "$env:TEMP\hevc.appxbundle"
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
Add-AppxPackage -Path $dest
```

**Risk**: CDN URLs for Store packages are not documented and change with each package
version. store.rg-adguard.net is a third-party scraper; relying on it in CI is fragile.

**Research task**: Obtain the current direct CDN URL for `9n4wgh0z6vhq`, confirm it
works with `Add-AppxPackage` on a fresh Windows Server 2025 VM, and decide if it's
stable enough to hardcode.

### AP-W3: Try `winget` with the named package ID instead of Store product ID

winget's msstore source may use a different identifier. Candidate IDs to try:

```
winget install "HEVC Video Extensions from Device Manufacturer" --source msstore ...
winget install --id Microsoft.HEVCVideoExtensionFromDeviceManufacturer --source winget ...
```

Run `winget search hevc --source msstore` on a live Windows 11 machine or inside a
GitHub Actions debug session to find the correct ID.

### AP-W4: Check if `choco` or another package manager carries HEVC

Chocolatey is already used in the CI workflow (`choco install ffmpeg`). If a community
package exists:

```yaml
- run: choco install hevc-codec -y
  if: matrix.os == 'windows-latest'
  continue-on-error: true
```

Search https://community.chocolatey.org for `hevc` to confirm availability and the
correct package name.

### AP-W5: Use `windows-2022` runner instead of `windows-latest`

The runner image is `windows-2025`. An older image (`windows-2022`) may have a
different pre-installed software set, potentially including the HEVC codec or a
Windows build where HEVC is included in-box. Minimal change:

```yaml
matrix:
  include:
    - os: windows-2022
      browser: edge
```

This is a quick experiment — just change the runner image and observe whether
`probeHevcMseSupport` returns true.

### AP-W6: Enable tmate debug session and inspect the runner directly

GitHub Actions supports `mxschmitt/action-tmate` for interactive SSH into the runner.
This would allow:

- Running `winget search hevc` to see what's available
- Trying `Add-AppxPackage` variants interactively
- Checking `Get-AppxPackage *hevc*` to see what's pre-installed
- Testing `[System.Net.Http.HttpClient]` access to the Store CDN

Useful for one-off investigation; not a production solution.

### AP-W7: Accept the limitation and add `continue-on-error` for Windows/Edge

If none of the above work, Windows/Edge HEVC tests will remain runner-dependent.
The cleanest mitigation is to mark the entire Windows/Edge e2e job as
`continue-on-error: true` (matching the existing policy for `ubuntu-latest / webkit`):

```yaml
continue-on-error: ${{ (matrix.os == 'ubuntu-latest' && matrix.browser == 'webkit')
                     || matrix.os == 'windows-latest' }}
```

The test result is still reported; it just doesn't fail the overall CI build. The
AP-3 "fully-skipped suite" annotation will continue to surface HEVC skips in the
CI summary so they remain visible.

This is the safe fallback if the codec cannot be reliably installed.

## Current State

The HEVC install step (commit `79932bc`) is still in the workflow with
`continue-on-error: true`. It does no harm — it runs, prints "HEVC not available",
and the job continues. If a working install method is found (AP-W2 through AP-W5),
the step body can be replaced without changing the surrounding structure.
