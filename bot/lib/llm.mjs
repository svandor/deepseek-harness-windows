/**
 * Házirobot — LLM-híd a helyi fallback proxyhoz.
 *
 * A bot SOHA nem hív modellt közvetlenül: a `providers/proxy.mjs` route-jain
 * keresztül megy (alapból `fast-chat`, azaz ingyenes lánc). Így a bot
 * költsége nulla, és ha a proxy áll, a bot akkor is lefut (determinisztikusan).
 */
export async function askLLM(cfg, { messages, route, maxTokens = 2048, temperature = 0.2, dryRun = false, log = () => {} }) {
  const model = route ?? cfg.proxy.route;
  if (dryRun || !cfg.llm.enabled) {
    log(`LLM kihagyva (${dryRun ? 'dry-run' : 'letiltva'}) — route: ${model}`);
    return { ok: false, skipped: true, text: '', tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }

  const url = `${cfg.proxy.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = { model, messages, max_tokens: maxTokens, temperature, stream: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.proxy.timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer hazirobot' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log(`LLM hiba: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { ok: false, error: `HTTP ${res.status}`, text: '', tokensIn: 0, tokensOut: 0, costUsd: 0 };
    }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? '';
    const usage = json.usage ?? {};
    return {
      ok: true,
      text,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      costUsd: 0, // ingyenes lánc
      model: json.model ?? model,
    };
  } catch (err) {
    log(`LLM kivétel: ${err.message}`);
    return { ok: false, error: err.message, text: '', tokensIn: 0, tokensOut: 0, costUsd: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** A bot napi költségkerete (a futásnaplóból). */
export function budgetOk(runs, limitUsd) {
  const spent = runs.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  return { ok: spent < limitUsd, spent };
}
