// ALIBABA VÉGPONTOK — a fiókspecifikus címek NEM a repóban élnek.
//
// A metódus nyilvános, az értékek nem: a címeket a credential-store
// (`refs:` szakasz) vagy környezeti változó adja:
//   ALIBABA_EU_BASE_URL = https://<WorkspaceId>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1
//   ALIBABA_SG_BASE_URL = https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function ref(name) {
  if (process.env[name]) return process.env[name];
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  if (!existsSync(file)) return undefined;
  const m = readFileSync(file, "utf8").match(new RegExp(`^\\s{2}${name}:\\s*(\\S+)\\s*$`, "m"));
  return m ? m[1] : undefined;
}

/** Az EU (Frankfurt) workspace OpenAI-kompatibilis végpontja. */
export function euBase() {
  const v = ref("ALIBABA_EU_BASE_URL");
  if (!v) throw new Error("nincs ALIBABA_EU_BASE_URL (credential-store vagy env)");
  return v.replace(/\/+$/, "");
}

/** A szingapúri workspace OpenAI-kompatibilis végpontja. */
export function sgBase() {
  const v = ref("ALIBABA_SG_BASE_URL");
  if (!v) throw new Error("nincs ALIBABA_SG_BASE_URL (credential-store vagy env)");
  return v.replace(/\/+$/, "");
}

/** A workspace-azonosító a címből (a napló/riport ehhez köti a régiót). */
export function workspaceId(base) {
  const m = /^https:\/\/([a-z0-9-]+)\./i.exec(String(base ?? ""));
  return m ? m[1] : null;
}
