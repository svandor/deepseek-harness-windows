/**
 * Naptári nap-határok magyar idő szerint.
 *
 * A felhasználó „dátum intervallumot” kér, és a nap az a nap, amit Ő élt meg —
 * nem UTC nap. Ezért a `YYYY-MM-DD` bemenet Europe/Budapest éjfélre fordul.
 * A téli/nyári időszámítás miatt a fix eltolás nem elég: az eltolást az adott
 * pillanatra kérdezzük le, és egyszer korrigálunk (a DST-váltás napjaira is
 * helyes eredményt adva).
 */

/** Az elszámolás időzónája. */
export const TIME_ZONE = "Europe/Budapest";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Egy pillanat eltolása a zóna szerint (ms): localWallClockUtc - epoch. */
export function zoneOffsetMs(epoch) {
  const parts = formatter.formatToParts(new Date(epoch));
  const field = (type) => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number.parseInt(found.value, 10);
  };
  // A `hour` "24" alakban is jöhet (éjfél) — a Date.UTC ezt értelmezi.
  const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return asUtc - epoch;
}

/**
 * `YYYY-MM-DD` -> az adott magyar nap 00:00:00.000 epoch ms értéke.
 * Hibás bemenetre `null`.
 */
export function dayStart(dateText) {
  if (typeof dateText !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const firstOffset = zoneOffsetMs(guess);
  let epoch = guess - firstOffset;
  const secondOffset = zoneOffsetMs(epoch);
  if (secondOffset !== firstOffset) epoch = guess - secondOffset;
  return epoch;
}

/**
 * `YYYY-MM-DD` -> a magyar nap VÉGE (a következő nap 00:00, kizárólagos).
 */
export function dayEnd(dateText) {
  const start = dayStart(dateText);
  if (start === null) return null;
  return nextDayStart(start);
}

/** A következő magyar nap 00:00-ja egy adott nap-kezdettől. */
export function nextDayStart(dayStartEpoch) {
  // 24 óra hozzáadása után a nap-kezdetet újraszámoljuk, hogy a DST ne csúsztasson.
  // Az óraátállítás napján a +24 óra még UGYANAZT a napot adhatja (25 órás nap),
  // ezért addig lépünk, amíg szigorúan nagyobb nap-kezdetet nem kapunk.
  let probe = dayStartEpoch + 24 * 3600000;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next = dayStart(dayOf(probe));
    if (next !== null && next > dayStartEpoch) return next;
    probe += 3600000;
  }
  return probe;
}

/** Egy pillanat magyar naptári napja `YYYY-MM-DD` alakban. */
export function dayOf(epoch) {
  const parts = formatter.formatToParts(new Date(epoch));
  const field = (type) => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? "0" : found.value;
  };
  return `${field("year").padStart(4, "0")}-${field("month").padStart(2, "0")}-${field("day").padStart(2, "0")}`;
}

/** Ma (magyar nap). */
export function today(now = Date.now()) {
  return dayOf(now);
}

/**
 * Az `N` nappal korábbi magyar nap kezdete (a mai napot is beleszámítva a
 * legutolsó teljes napokhoz).
 */
export function daysAgoStart(days, now = Date.now()) {
  const start = dayStart(today(now)) ?? now;
  return start - Math.max(0, days - 1) * 24 * 3600000 > 0 ? start - Math.max(0, days - 1) * 24 * 3600000 : start;
}
