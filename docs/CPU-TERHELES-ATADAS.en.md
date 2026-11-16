# CPU load: root causes found and hand-off (2026-11-16)

**Initial complaint:** "desktop switching takes over a minute again, the Git panel comes
up slowly, something is eating or spinning in the background." Then: "the CPU is at 73%",
"this is contradictory" (Task Manager 73% vs MSI Center 35%), and finally: "what is
`WmiPrvSE.exe` and who is using it?"

**Machine:** `VECTOR` — Intel Core Ultra 9 275HX, **24 logical cores**, 32 GB RAM,
RTX 5080 Laptop, Windows 11. DSH harness `pid 27820` (during measurement), two work
windows × 3 panes.

**In one sentence:** the *painful* slowdown was caused by DSH's own `/devadmin/state`
poll storm (fixed, v0.2.5, active); the *remaining* CPU is **not** DSH but the vendor
monitoring stack (MSI Center + Intel Energy Server) and Windows' own services reading
sensors over WMI — calming those needs elevation (a one-click tool was built for it).

---

## 1. How CPU must be measured here (and what to avoid)

### 1.1 "73% vs 35%" is not a contradiction: two different counters

Measured in the same minute:

| counter | value | where you see it |
|---|---|---|
| `% Processor Time` (core time: fraction of time not idle) | **29–33%** | MSI Center, PDH `Processor` set, `Get-Counter '\Processor(_Total)\% Processor Time'` |
| `% Processor Utility` (frequency weighted) | **46–83%** | **Windows 11 Task Manager** (its default) |

Task Manager shows the frequency-weighted value: how much work a core does relative to
its *nominal* clock. With turbo (measured 4.02 GHz) this is substantially higher than the
idle-based figure. **Heat and power correlate with the frequency-weighted value**
(measured 89 °C CPU temperature under real load). Neither number is "wrong" — always
state which one you mean.

### 1.2 Pitfalls we already hit

1. **`Get-Process` reports SYSTEM processes as 0.00% CPU.** `WmiPrvSE.exe` (the machine's
   top consumer) was invisible in the process list for a long time. Use **PDH counters**
   (`Get-Counter`); they need no process rights.
2. **PDH's `(*)` wildcard path is flaky:** `800007D2` / "sample data is not valid" when a
   process is created or exits mid-collection. Query **per instance**, in batches of 40,
   with per-sample `try/catch`.
3. **SUM same-named instances, never average them.** Our own bug, MEASURED: averaging
   showed the machine at **8%** while the real figure was **~30%** (54 `msedgewebview2`
   instances). This bug produced a wrong conclusion set and has been fixed.
4. **Counter names are localised** (`Folyamat` / `Process`, `Processzorinformációk` /
   `Processor Information`). Discover them at runtime (`Get-Counter -ListSet *`); do not
   hardcode English names.
5. **The WMI-Activity log records only FAILING client calls** (5858) plus provider loads
   (5857). *Successful* polling leaves no trace — continuous load can only be attributed
   indirectly (correlation, switching suspects off).

---

## 2. The loads that were found

### 2.1 DSH `/devadmin/state` poll storm — FIXED, ACTIVE

**Symptom:** desktop switch > 60 s, Git panel loading slowly, 14 `php-cgi` workers at
5–10%, harness `node` at 128–147%.

**Root cause:** the `dsh-devadmin` host's `handleState` issued an **HTTP probe of the dev
sites on every call** (Laravel render, per site) plus port-owner lookups; the header
switcher called it **every 2 s from every pane** (6 panes → ~3 calls/s). `/devadmin/state`
took **2794–3044 ms** while other routes took 2–4 ms. Requests arrived faster than they
could be served, so the queue grew without bound — the header's 1/2 button write and the
Git panel ended up at the back of the queue (**that was the one minute**).

**Measurement:** in the dev sites' access log, **2995 of the last 3000 requests** were
`GET /` from `127.0.0.1` with `user-agent: dsh-devadmin`; the log grew to **24.9 MB**.

**Fix (v0.2.5, commit `41c950c`):**
1. the state response is **cached for 15 s** (`?fresh=1` bypasses it),
2. new **cheap read endpoint**: `GET /devadmin/desktop` (without `n`) →
   `{ok, desktop, desktopCount}` — two file reads, no network,
3. the client switcher is **self-paced**: 5 s on the cheap endpoint, **30 s** fallback when
   the old host 404s, hidden panes do not poll, one-off re-read 600 ms/2 s after a click,
4. the Admin panel went 5 s → **15 s** and does not refresh while hidden.

**Activation (07:44, with the user's permission):** both work windows were restarted with
verified PIDs (the running images came from the older binary:
`DshWindow.exe.old-20261116-071825`); the tray does **not** recreate the non-active
desktop's window by itself → it had to be created by writing `window-desktop.txt` 2→1.

**Result (measured):**

| metric | before | after |
|---|---|---|
| devadmin probe rate | 1.5/s (peak) | **0.20/s** |
| harness CPU | 128% (during our own turn) | **1.8%** (idle) |
| desktop switch | **> 60 s** | **145 / 108 / 108 / 109 ms** |
| pane init | — | 6/6 **first attempt**, **0 `[ERROR]`** |

**Open:** the host-side 15 s cache only becomes active after a **harness restart**
(deferred because sessions were running; it activates on the next natural start).

### 2.2 WMI Provider Host (`WmiPrvSE.exe`) — 0.5–0.9 core sustained, 1.0–1.75 at peak

**What it is:** the host process for WMI providers (Microsoft,
`C:\Windows\System32\wbem`). It does nothing on its own: it **executes other programs' WMI
queries** and runs with the client's credentials (hence 4 instances: SYSTEM, NETWORK
SERVICE, user).

**Providers measured (5857, 07:07–08:10):** `MSVDS__PROVIDER`, `MSI_CPU`/`MSI_VGA`/`MSI_AP`,
`PowerWmiProvider`, `Win32_DeviceGuard`, `NetAdapterCim`, `DeliveryOptimizationMIProv`,
`ProtectionManagement` + `Win32_TpmProvider` (Defender), `WmiPerfInst`/`WmiPerfClass`
(performance counters), `CIMWin32a`, `StorageWMI`, `nettcpip`, `Win32_WinSAT`, `SppProvider`.

**Clients measured (5858, failing calls only):**

| client | count | what it asked | why it matters |
|---|---|---|---|
| `DoSvc` (svchost, NETWORK SERVICE) | **160** | `SELECT * FROM MSFT_NetAdapterStatisticsSettingData WHERE Name = 'Ethernet'` → `0x80041032` | **retry loop every 2 s that ALWAYS fails**: no adapter is named "Ethernet" |
| MSI `Sendevsvc` (Sensor dev service) | 52 | `MSI_CPU` / `MSI_VGA` / `MSI_AP` | the continuous sensor polling (successful calls are not logged) |
| MSI `GamebarTool` | 18 | `Win32_DeviceGuard` | game overlay (stopped during the investigation) |
| NVIDIA `nvcontainer` | 8 | WMI query | — |
| MSI `CentralServer` | 3 | WMI query | the open MSI Center window (measured ~1 core!) |

**Important:** **never disable WMI** (Windows management depends on it: PowerShell, event
log, installers, Defender, network, storage, power plans). The right intervention is
calming the **clients**.

**Tool (needs elevation; the script elevates itself):** `tools\wmi-calm.cmd`
(`wmi-calm.ps1`: `-Report` measures only, `-StopOnly` does not persist). It stops the MSI
`Sendevsvc` / `MSI_Center_Service` / `MSI_Companion_Service` / `MSI Foundation Service`
services, the `TraceFPS`/`CentralServer`/`GamebarTool`/`TerminalServer` processes (**only
after verifying their MSI path**), and `DoSvc`; sets them to `Manual`; **measures the
`wmiprvse` CPU before and after**; and prints the restore commands. The UAC prompt is
approved by the user — an agent must not raise a focus-stealing window.

### 2.3 Pane renderers — ~3 cores, but this is not a leak

3 `msedgewebview2` renderers run at ~100% continuously; the session logs show they are
exactly the **3 panes displaying live/recent sessions** (the user's work plus this
session). 54 WebView2 processes, ~6.2 GB. This is the cost of streaming plus drawing a
large conversation; the 6-pane layout (2 windows × 3) multiplies it.
**If heat/CPU matters, this is the single largest item:** reducing the pane count (tray →
*Window split*) removes ~1 core of renderer per pane.

### 2.4 Other system-level load (not DSH)

| process | measured | note |
|---|---|---|
| `memory compression` | ~1.6 cores | RAM 22.6 / 31.4 GB = **72%** — memory pressure |
| `esrv_svc` (Intel Energy Server, QUEENCREEK) | ~0.9 cores | Intel dynamic energy/thermal service, also reads sensors |
| `RaiderBridge` node | 60–76% | the **approved** website bridge — AGENTS 2.1 says not to re-investigate |
| `MSI.CentralServer` | ~1 core | the open MSI Center (Hardware Monitoring tab) |
| `MsMpEng` (Defender) | 3–5% | — |
| `ollama` | 13.8% (one sample) | calling the local model is forbidden on Windows; the bridge decision belongs to the user |

---

## 3. Current state (2026-11-16, around 08:15)

- Machine: **~30% core time / ~65% frequency-weighted**, 89 °C CPU temperature.
- DSH: harness 2–10% when idle, **6 panes**, 2 work windows, desktop switch
  **108–145 ms**, devadmin probe rate **0.20/s**.
- DSH has **no** timed WMI calls (only event-driven CIM: run restore, kill verification,
  command-line verification); the devadmin panel calls `netstat`/`tasklist`, not WMI.

---

## 4. Open items / decisions needed

1. **The fate of MSI Center** (the largest single item on the system-level list): after
   running `wmi-calm.cmd` the sensors/overlay stop; the fan curve stays in the EC/BIOS.
   Restoring is one line (`Set-Service ... -StartupType Automatic; Start-Service ...`).
2. **The harness restart** (to activate the 15 s host cache): only with the user's
   permission and no running work (§1.5).
3. **`DoSvc`'s failing adapter loop**: either rename the adapter to "Ethernet" or stop the
   service — Windows-side, a decision.
4. **Access-log rotation**: the Caddy access logs sit at 24.9 MB (a secondary symptom of
   the storm); adding `roll_size` to the log output in `dev.ps1` is worthwhile.
5. **Next candidates if more CPU is needed:** `NahimicService`, `IntelCollectorService`,
   `IntelTelemetryAgent` (via the `wmi-calm.ps1 -IncludeIntel` switch) and other
   third-party monitors — by measurement, not by guessing.
6. **Memory pressure:** the 1.6 cores of `memory compression` come from the 72% RAM; fewer
   panes relieve it too.

---

## 5. What NOT to do

- **Do not disable WMI** or delete `WmiPrvSE.exe` ("optimizer" advice): Windows management
  becomes unusable.
- **Never kill by name** (`Stop-Process -Name`, `taskkill /IM`): only verified PIDs, and the
  harness pid (`state\harness.pid`) must not be in the list (AGENTS §1.6).
- **Do not restart the harness while work is running** without permission (§1.5).
- **Do not raise UAC/console windows from an agent** (§1.3) — that is why the elevated tool
  needs the user's single click.
- **Do not average same-named PDH instances** (see 1.2/3).

---

## 6. Tools and reproducible commands

| tool | what it does |
|---|---|
| `tools\perf-check.ps1` | per-process CPU, **PDH including SYSTEM processes**, core time vs frequency-weighted, devadmin probe rate, verdict. Read-only. |
| `tools\wmi-calm.cmd` + `.ps1` | calm down the WMI consumers (elevated, self-elevating) with before/after measurement |
| `wmi-calm.ps1 -Report` | measurement/plan only, no elevation needed |

```powershell
# full measurement
.\tools\perf-check.ps1

# read the WMI clients out of the log (which pid asked what)
$ev = Get-WinEvent -LogName 'Microsoft-Windows-WMI-Activity/Operational' -MaxEvents 400
foreach ($e in $ev | Where-Object Id -eq 5858) {
    $u = ([xml]$e.ToXml()).Event.UserData.Operation_ClientFailure
    '{0:HH:mm:ss} pid={1} user={2} {3}  {4}' -f $e.TimeCreated, $u.ClientProcessId, $u.User, $u.ResultCode, $u.Operation
}
# which provider was loaded (what is being asked for)
foreach ($e in $ev | Where-Object Id -eq 5857) {
    $u = ([xml]$e.ToXml()).Event.UserData.Operation_StartedOperational
    '{0:HH:mm:ss} {1}  ({2})  host={3}/{4}' -f $e.TimeCreated, $u.ProviderName, $u.ProviderPath, $u.HostProcess, $u.ProcessID
}
```

**Operational fact needed to interpret the measurements:** the `DshWindow` windows use a
separate WebView2 profile per desktop (`state\webview2\pane-N`, `pane-N-d2`); panes receive
the served client bundle **at load time**, so a client-side fix requires a **pane reload**,
and a host-side fix requires a **harness restart**.

---

## 7. Commits

- `41c950c` — stop the devadmin poll storm (host cache + cheap endpoint + self-paced client)
- `b05bd0f` — Release v0.2.5 (installer + portable)
- `b930cb1` — changelog: root cause and fix of the storm
- `7d1085c` — `tools\perf-check.ps1` (measurement tool)
- `a5517ef` — record the measured activation
- `e1fd5ea` — SYSTEM-level measurement via PDH + documentation of the WMI consumers
- `fa5cdf3` — core time vs frequency-weighted explanation + `wmi-calm`
- `b7fb386` — one-click launcher (`wmi-calm.cmd`) + metric note
