# CPU-terhelés: feltárt okok és átadás (2026-11-16)

**Kiinduló panasz:** „1 perc fölötti az asztalváltási idő, a Git ablak lassan jön fel,
valami zabál vagy bepörög a háttérben." Majd: „73% a CPU", „ez ellentmondásos"
(Task Manager 73% vs MSI Center 35%), végül: „mi ez a `WmiPrvSE.exe` és ki használja?"

**Gép:** `VECTOR` — Intel Core Ultra 9 275HX, **24 logikai mag**, 32 GB RAM,
RTX 5080 Laptop, Windows 11. DSH harness `pid 27820` (a mérés idején), két
munkaablak × 3 panel.

**Egy mondat a lényeg:** a *fájdalmas* lassulást a DSH saját `/devadmin/state`
poll-vihara okozta (javítva, v0.2.5, aktív); a *maradék* CPU-t nem a DSH eszi,
hanem a gyártói monitorozó réteg (MSI Center + Intel Energy Server) és a Windows
saját szolgáltatásai, amelyek WMI-n keresztül olvassák az érzékelőket — ezek
visszafogása emelt jogot igényel (egykattintásos eszköz készült rá).

---

## 1. Hogyan kell itt CPU-t mérni (és mibe ne fuss bele)

### 1.1 A „73% vs 35%" nem ellentmondás: két különböző mutató

Ugyanabban a percben mérve:

| mutató | érték | hol látszik |
|---|---|---|
| `% Processor Time` (mag-idő: az idő hányadában nem idle) | **29–33%** | MSI Center, PDH `Processzor` készlet, `Get-Counter '\Processzor(_Total)\A processzor kihasználtsága (%)'` |
| `% Processor Utility` (frekvencia-súlyozott) | **46–83%** | **Windows 11 Task Manager** (ezt mutatja alapból) |

A Task Manager a frekvencia-súlyozott értéket mutatja: mennyi munkát végez a mag a
*névleges* órajelhez képest. Turbo mellett (mért 4,02 GHz) ez lényegesen nagyobb,
mint az idle-alapú. **A hő és a fogyasztás a frekvencia-súlyozottal korrelál**
(mért 89 °C CPU-hőmérséklet valós terhelés mellett). Egyik szám sem „hibás" —
ezért kell mindig megmondani, melyik mutatóról beszélünk.

### 1.2 Buktatók, amelyekbe MÁR belefutottunk

1. **A `Get-Process` a SYSTEM folyamatok CPU-ját 0,00-nak látja.** A `WmiPrvSE.exe`
   (a gép legnagyobb fogyasztója) hosszú ideig láthatatlan volt a listában.
   Megoldás: **PDH-számlálók** (`Get-Counter`), azok nem kérnek process-jogot.
2. **A PDH `(*)`-os gyűjtőútvonala ingatag:** `800007D2` / „a minta érvénytelen",
   ha közben processz születik vagy hal. Megoldás: **példányonként** kérdezni,
   kötegekben (40-es csomagok), mintánként `try/catch`-csel.
3. **Az azonos nevű példányokat ÖSSZEGEZD, ne átlagold.** Saját hiba, MÉRVE:
   az átlagolás a gépet **8%-nak** mutatta, miközben a valóság **~30%** volt
   (54 `msedgewebview2` példány). Ez a hiba egy hibás következtetés-készletet
   termelt, ezért javítva van.
4. **A számlálónevek nyelvenként mások** (`Folyamat` / `Process`,
   `Processzorinformációk` / `Processor Information`). Futásidőben derítsd ki
   (`Get-Counter -ListSet *`), ne hardcode-old az angol neveket.
5. **A WMI-Activity napló csak a HIBÁS klienshívásokat rögzíti** (5858) és a
   szolgáltatók betöltését (5857). A *sikeres* pollozás nyoma veszik — a
   folyamatos terhelést csak közvetett úton (korreláció, kikapcsolás) lehet
   ügyfélhez kötni.

---

## 2. A feltárt terhelések

### 2.1 DSH `/devadmin/state` poll-vihar — JAVÍTVA, AKTÍV

**Tünet:** asztalváltás > 60 s, a Git panel lassan tölt, 14 `php-cgi` munkás
5–10%-on, a harness `node` 128–147%.

**Gyökér:** a `dsh-devadmin` host `handleState`-je **minden hívásnál** HTTP-próbát
indított a fejlesztői oldalakra (Laravel-render, site-onként) + port-tulajdonost
kérdezett; a fejléc-váltó **2 s-onként, minden panelből** hívta (6 panel → ~3 hívás/s).
A `/devadmin/state` **2794–3044 ms** volt, miközben a többi route 2–4 ms. Mivel a
kérések sűrűbben érkeztek, mint a kiszolgálás, a sor korlátlanul nőtt — a fejléc
1/2 gombjának írása és a Git panel a sor végére került (**ez volt az 1 perc**).

**Mérés:** a dev oldalak access-logjában az utolsó 3000 kérésből **2995 `GET /`**,
mind `127.0.0.1`, `user-agent: dsh-devadmin`; a log **24,9 MB**-ra hízott.

**Javítás (v0.2.5, commit `41c950c`):**
1. a state-válasz **15 s-ig cache-elt** (`?fresh=1` megkerüli),
2. új **olcsó olvasó végpont**: `GET /devadmin/desktop` (`n` nélkül) →
   `{ok, desktop, desktopCount}` — két fájlolvasás, hálózat nélkül,
3. a kliens-váltó **öntempózó**: olcsó végpontnál 5 s, a régi host 404-jénél
   **30 s** tartalék, rejtett panel nem polloz, kattintás után 600 ms/2 s egyszeri
   újraolvasás,
4. az Admin panel 5 s → **15 s**, rejtve nem frissít.

**Aktiválás (07:44, a felhasználó engedélyével):** a két munkaablak újraindult
ellenőrzött PID-del (a futó képek a régi binárisból jöttek:
`DshWindow.exe.old-20261116-071825`), a tálca a **nem aktív** asztal ablakát
magától nem indítja újra → a `window-desktop.txt` 2→1 írásával kellett létrehozni.

**Eredmény (mért):**

| mérőszám | előtte | utána |
|---|---|---|
| devadmin próba-ráta | 1,5/s (csúcs) | **0,20/s** |
| harness CPU | 128% (saját kör alatt) | **1,8%** (tétlen) |
| asztalváltás | **> 60 s** | **145 / 108 / 108 / 109 ms** |
| panelek init | — | 6/6 **első próbából**, **0 `[ERROR]`** |

**Nyitva:** a host-oldali 15 s cache csak **harness-újraindítás** után él (a futó
sessionök miatt elhalasztva; a következő természetes indításnál magától bekapcsol).

### 2.2 WMI Provider Host (`WmiPrvSE.exe`) — 0,5–0,9 mag folyamatosan, csúcsban 1,0–1,75

**Mi ez:** a WMI-szolgáltatók gazdafolyamata (Microsoft, `C:\Windows\System32\wbem`).
Önmagában semmit nem csinál: **más programok WMI-kéréseit hajtja végre**, és a
kliens jogosultságaival fut (ezért van 4 példány: SYSTEM, NETWORK SERVICE, user).

**Mért szolgáltatók (5857, 07:07–08:10):** `MSVDS__PROVIDER`, `MSI_CPU`/`MSI_VGA`/
`MSI_AP`, `PowerWmiProvider`, `Win32_DeviceGuard`, `NetAdapterCim`,
`DeliveryOptimizationMIProv`, `ProtectionManagement` + `Win32_TpmProvider`
(Defender), `WmiPerfInst`/`WmiPerfClass` (teljesítmény-számlálók), `CIMWin32a`,
`StorageWMI`, `nettcpip`, `Win32_WinSAT`, `SppProvider`.

**Mért ügyfelek (5858, csak a hibás hívások):**

| ügyfél | db | mit kért | miért fontos |
|---|---|---|---|
| `DoSvc` (svchost, NETWORK SERVICE) | **160** | `SELECT * FROM MSFT_NetAdapterStatisticsSettingData WHERE Name = 'Ethernet'` → `0x80041032` | **2 s-onként ismételt, MINDIG hibázó ciklus**: nincs „Ethernet" nevű adapter |
| MSI `Sendevsvc` (Sensor dev service) | 52 | `MSI_CPU` / `MSI_VGA` / `MSI_AP` | a folyamatos érzékelő-pollozás (a sikeres hívások nem kerülnek naplóba) |
| MSI `GamebarTool` | 18 | `Win32_DeviceGuard` | játék-overlay (leállítva a vizsgálat közben) |
| NVIDIA `nvcontainer` | 8 | WMI lekérdezés | — |
| MSI `CentralServer` | 3 | WMI lekérdezés | a nyitott MSI Center ablak (mért ~1 mag!) |

**Fontos:** a WMI-t **tilos kikapcsolni** (a Windows menedzsmentje erre épül:
PowerShell, eseménynapló, telepítők, Defender, hálózat, tárhely, energiaséma).
A helyes beavatkozás a **hívók** visszafogása.

**Eszköz (emelt jog kell, a szkript magát emeli):** `tools\wmi-calm.cmd`
(`wmi-calm.ps1`: `-Report` csak mér, `-StopOnly` nem perzisztál). Leállítja az MSI
`Sendevsvc` / `MSI_Center_Service` / `MSI_Companion_Service` / `MSI Foundation Service`
szolgáltatást, a `TraceFPS`/`CentralServer`/`GamebarTool`/`TerminalServer` folyamatokat
(**csak ellenőrzött MSI-útvonal alapján**), a `DoSvc`-t, `Manual` indításra állít, és
**előtte/utána méri a `wmiprvse` CPU-ját**; a végén kiírja a visszaállító parancsokat.
Az UAC-ablakot a felhasználó hagyja jóvá — ágens nem hozhat fel fókuszra törő ablakot.

### 2.3 Panel-rendererek — ~3 mag, de ez nem szivárgás

3 `msedgewebview2` renderer folyamatosan ~100%-on; a session-naplók tanúsága szerint
pontosan a **3 élő/közeli sessiont mutató panel** (a felhasználó munkája + ez a
session). 54 WebView2 folyamat, ~6,2 GB. Ez a streamelés + nagy beszélgetés
kirajzolásának költsége; a 6 panel méretezés (2 ablak × 3) ezt megsokszorozza.
**Ha hő/CPU gond van, itt a legnagyobb egyetlen tétel:** a panelszám csökkentése
(tálca → *Ablak felosztása*) 1 renderert ~1 maggal visz el.

### 2.4 Rendszerszintű egyéb (nem DSH)

| folyamat | mért | megjegyzés |
|---|---|---|
| `memory compression` | ~1,6 mag | RAM 22,6 / 31,4 GB = **72%** — memórianyomás jele |
| `esrv_svc` (Intel Energy Server, QUEENCREEK) | ~0,9 mag | Intel dinamikus energia/termikus szolgáltatás, érzékelőket is olvas |
| `RaiderBridge` node | 60–76% | a **jóváhagyott** weboldal-bridge — AGENTS 2.1 szerint nem vizsgáljuk tovább |
| `MSI.CentralServer` | ~1 mag | a nyitott MSI Center (Hardware Monitoring fül) |
| `MsMpEng` (Defender) | 3–5% | — |
| `ollama` | 13,8% (1 minta) | helyi modell hívása tilos Windows alatt; a bridge-döntés a felhasználóé |

---

## 3. Jelenlegi állapot (2026-11-16, 08:15 körül)

- Gép: **~30% mag-idő / ~65% frekvencia-súlyozott**, 89 °C CPU-hőmérséklet.
- DSH: harness tétlen állapotban 2–10%, **6 panel**, 2 munkaablak, asztalváltás
  **108–145 ms**, devadmin próba-ráta **0,20/s**.
- A DSH-nak **nincs** időzített WMI-hívása (csak eseményhez kötött CIM: futás-
  visszaállítás, leállítás-ellenőrzés, parancssor-ellenőrzés); a devadmin panel
  `netstat`/`tasklist`-et hív, nem WMI-t.

---

## 4. Nyitva maradt / döntést igényel

1. **MSI Center sorsa** (a legnagyobb egyetlen tétel a rendszerszintű listán):
   a `wmi-calm.cmd` lefuttatása után az érzékelők/overlay kikapcsolnak; a
   ventilátor-görbe az EC/BIOS-ban marad. Visszaállítás egy sor
   (`Set-Service ... -StartupType Automatic; Start-Service ...`).
2. **A harness-újraindítás** (a 15 s host-cache aktiválásához): csak a felhasználó
   engedélyével, futó munka nélkül (§1.5).
3. **`DoSvc` hibás adapter-ciklusa**: vagy az adaptert kell „Ethernet"-re nevezni,
   vagy a szolgáltatást leállítani — Windows-oldali, döntés kérdése.
4. **Access-log rotáció**: a Caddy access-logok 24,9 MB-on állnak (a vihar
   másodlagos tünete); érdemes `dev.ps1`-ben `roll_size`-ot adni a log-outputnak.
5. **Következő jelöltek, ha még kell CPU:** `NahimicService`, `IntelCollectorService`,
   `IntelTelemetryAgent` (a `wmi-calm.ps1 -IncludeIntel` kapcsolóval), illetve
   harmadik féltől származó monitorozók — csak méréssel, nem találgatással.
6. **Memórianyomás:** a `memory compression` 1,6 magja a 72%-os memóriából jön;
   a panelek számának csökkentése ezt is enyhíti.

---

## 5. Amit NE tegyél

- **Ne állítsd le a WMI-t** és ne töröld a `WmiPrvSE.exe`-t („optimalizáló"
  tanácsok): a Windows menedzsmentje működésképtelenné válik.
- **Ne ölj folyamatot NÉV szerint** (`Stop-Process -Name`, `taskkill /IM`):
  csak ellenőrzött PID-et, és a harness pidje (`state\harness.pid`) nem lehet a
  listában (AGENTS §1.6).
- **Ne indíts újra harness-t futó munka mellett** engedély nélkül (§1.5).
- **Ne hozz fel UAC/konzol-ablakot ágensből** (§1.3) — ezért kell a felhasználó
  egyetlen kattintása az emelt eszközhöz.
- **Ne átlagold az azonos nevű PDH-példányokat** (lásd 1.2/3).

---

## 6. Eszközök és reprodukálható parancsok

| eszköz | mit tesz |
|---|---|
| `tools\perf-check.ps1` | CPU processzenként, **PDH-val a SYSTEM folyamatokkal együtt**, mag-idő vs frekvencia-súlyozott, devadmin próba-ráta, verdict. Csak olvas. |
| `tools\wmi-calm.cmd` + `.ps1` | WMI-fogyasztók csillapítása (emelt jog, önemelő), előtte/utána méréssel |
| `tools\perf-check.ps1 -Report` helyett: `wmi-calm.ps1 -Report` | csak mérés/terv, emelt jog nélkül |

```powershell
# teljes mérés
.\tools\perf-check.ps1

# WMI-ügyfelek kiolvasása a naplóból (melyik pid, mit kért)
$ev = Get-WinEvent -LogName 'Microsoft-Windows-WMI-Activity/Operational' -MaxEvents 400
foreach ($e in $ev | Where-Object Id -eq 5858) {
    $u = ([xml]$e.ToXml()).Event.UserData.Operation_ClientFailure
    '{0:HH:mm:ss} pid={1} user={2} {3}  {4}' -f $e.TimeCreated, $u.ClientProcessId, $u.User, $u.ResultCode, $u.Operation
}
# melyik szolgáltató töltődött be (mit kérdeznek)
foreach ($e in $ev | Where-Object Id -eq 5857) {
    $u = ([xml]$e.ToXml()).Event.UserData.Operation_StartedOperational
    '{0:HH:mm:ss} {1}  ({2})  host={3}/{4}' -f $e.TimeCreated, $u.ProviderName, $u.ProviderPath, $u.HostProcess, $u.ProcessID
}
```

**Fontos üzemeltetési tény** (a mérés értelmezéséhez): a `DshWindow` ablakok
asztalonként külön WebView2-profilt használnak (`state\webview2\pane-N`,
`pane-N-d2`); a panelek a kiszolgált kliens-csomagot **betöltéskor** kapják, ezért
kliens-oldali javítás **panel-újratöltést** igényel, host-oldali javítás
**harness-újraindítást**.

---

## 7. Commitok

- `41c950c` — a devadmin poll-vihar megszüntetése (host-cache + olcsó végpont + öntempózó kliens)
- `b05bd0f` — Release v0.2.5 (installer + portable)
- `b930cb1` — változásnapló: a vihar gyökere és a javítás
- `7d1085c` — `tools\perf-check.ps1` (mérő)
- `a5517ef` — a mért aktiválás rögzítése
- `e1fd5ea` — SYSTEM-szintű mérés PDH-val + a WMI-fogyasztók dokumentálása
- `fa5cdf3` — mag-idő vs frekvencia-súlyozott magyarázat + `wmi-calm`
- `b7fb386` — egykattintásos indító (`wmi-calm.cmd`) + metrika-megjegyzés
