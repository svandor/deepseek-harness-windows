/**
 * A profil-patch ellenőrzése: érvényes YAML-e, és benne van-e a dsh-heap-guard
 * bejegyzés. A `js-yaml` a DSH profiljából jön (a repóból nem elérhető).
 *
 * Használat: node lib/check-patch.mjs <cordis.patch.yml> <profil package.json>
 * Kilépés: 0 = rendben, 2 = a bejegyzés hiányzik, 1 = hiba.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [patchFile, profilePackage] = process.argv.slice(2);
if (!patchFile || !profilePackage) {
  console.error('használat: node lib/check-patch.mjs <cordis.patch.yml> <profil package.json>');
  process.exit(1);
}

try {
  const require = createRequire(profilePackage);
  const yaml = require('js-yaml');
  const data = yaml.load(readFileSync(patchFile, 'utf8'));
  const entries = Array.isArray(data) ? data : [];
  const names = [];
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if ((key === 'name' || key === 'id') && typeof inner === 'string') names.push(inner);
        walk(inner);
      }
    }
  };
  walk(entries);
  const found = names.includes('dsh-heap-guard') || names.includes('heap-guard');
  console.log(JSON.stringify({ entries: entries.length, heapGuard: found, validYaml: true }));
  process.exit(found ? 0 : 2);
} catch (error) {
  console.log(JSON.stringify({ validYaml: false, error: String(error) }));
  process.exit(1);
}
