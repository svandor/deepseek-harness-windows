window.__ModuleLoader__.load({
	id: "dsh-auto-status",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		// ── beallitasok ────────────────────────────────────────────────────
		/** A helyi fallback proxy (a `Auto` modell szolgaltatoja) allapot-vegpontja. */
		const HEALTHZ = "http://127.0.0.1:4123/healthz";
		/** Ennyi idonkent kerdezzuk ujra (a proxy /healthz-e olcso, helyi olvasas). */
		const POLL_MS = 5000;
		/** Ennyi masodpercnel frissebb dontest mutatunk "elo" allapotkent. */
		const FRESH_SEC = 180;

		/**
		 * A /healthz valaszabol kivalasztja a legfrissebb Auto-celt.
		 * A proxy `intelligent.sessions[]` elemei: { session, firstUser, label,
		 * reason, steps, switches, idleSec }. Tobb parhuzamos Auto-session eseten
		 * a legfrissebbet mutatjuk, a tobbit "+N"-nel jelezzuk.
		 * @param payload - a /healthz JSON valasza.
		 * @returns { label, others, title } vagy null, ha nincs friss dontes.
		 */
		function summarize(payload) {
			const sessions = payload?.intelligent?.sessions;
			if (!Array.isArray(sessions)) return null;
			const fresh = sessions
				.filter((s) => s && typeof s.label === "string" && s.label.length > 0 && Number(s.idleSec) <= FRESH_SEC)
				.sort((a, b) => Number(a.idleSec) - Number(b.idleSec));
			if (fresh.length === 0) return null;
			const best = fresh[0];
			const others = fresh.length - 1;
			const parts = [`Auto → ${best.label}`];
			if (typeof best.reason === "string" && best.reason.length > 0) parts.push(best.reason);
			if (others > 0) parts.push(`${others} további aktív Auto session`);
			return { label: best.label, others, title: parts.join(" · ") };
		}

		// ── stilusok (inline; a temabol orokolt valtozokkal) ────────────────
		const WRAP = {
			display: "flex",
			alignItems: "center",
			gap: "6px",
			padding: "0 2px",
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
			minWidth: 0,
		};
		const DOT = {
			width: "6px",
			height: "6px",
			borderRadius: "50%",
			background: "var(--dsw-alias-state-success-primary, #4caf50)",
			flex: "none",
		};
		const MODEL = {
			color: "var(--dsw-alias-label-secondary, #b8b8b8)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			minWidth: 0,
		};
		const DIM = { opacity: 0.65, flex: "none" };

		/**
		 * A composer feletti allapotsav (input dock). Csak akkor rajzol, ha a
		 * proxy mutat friss Auto-dontest; egyebkent semmit (null), hogy ne
		 * foglaljon helyet, ha epp nem az Auto dolgozik.
		 */
		function AutoStatusDock() {
			const [view, setView] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const read = async () => {
					try {
						const res = await fetch(HEALTHZ, { cache: "no-store" });
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const payload = await res.json();
						if (alive) setView(summarize(payload));
					} catch {
						// Nema hiba: ha a proxy all vagy nem valaszol, a sav eltunik.
						if (alive) setView(null);
					}
				};
				read();
				const timer = setInterval(read, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			if (view === null) return null;
			return react.createElement(
				"div",
				{ style: WRAP, title: view.title },
				react.createElement("span", { style: DOT }),
				react.createElement("span", { style: DIM }, "Auto"),
				react.createElement("span", { style: DIM }, "\u2192"),
				react.createElement("span", { style: MODEL }, view.label),
				view.others > 0 ? react.createElement("span", { style: DIM }, `+${view.others}`) : null,
			);
		}

		// ── plugin ──────────────────────────────────────────────────────────
		/** A composer allapotsavjanak slot-neve (a ui-conversation deklaralja). */
		const DOCK_SLOT = "conversation.input.dock";
		/** Csak a slot-szolgaltatasra van szukseg: a komponens maga kerdez le. */
		const inject = ["slots"];

		/**
		 * Kliens plugin test: egyetlen bejegyzes a composer feletti dokkban.
		 * @param ctx - kliens gyoker-kontextus.
		 */
		function apply(ctx) {
			ctx.slots.inject(DOCK_SLOT, () =>
				ctx.slots.register(
					{
						name: DOCK_SLOT,
						id: "auto-status",
						order: 20,
					},
					AutoStatusDock,
				),
			);
		}

		exports.AutoStatusDock = AutoStatusDock;
		exports.apply = apply;
		exports.inject = inject;
		exports.summarize = summarize;
		return module.exports;
	},
});
