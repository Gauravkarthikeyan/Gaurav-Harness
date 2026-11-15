/**
 * Cell-grid provider list for the setup sign-in step: the `/login` providers grouped into OAuth subscriptions,
 * API keys and local servers, with a status dot for the ones that already hold a credential. Type to filter,
 * ↑/↓ to move, Enter to sign in, Esc clears the filter and then leaves the step. Reads the same provider list
 * and credential store as the `/login` selector; it only presents them.
 */
import type { KeysApi } from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { extractPrintableText, matchesKey } from "../../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../keybinding-matchers";
import type { SgrMouseEvent } from "../../mouse";
import { theme } from "../../theme/theme";
import type { Component } from "../../tui";
import { truncateToWidth, visibleWidth } from "../../utils";

export type ProviderGroup = "oauth" | "api-key" | "local";

export const PROVIDER_GROUP_ORDER: readonly ProviderGroup[] = ["oauth", "api-key", "local"];
export const PROVIDER_GROUP_LABELS: Readonly<Record<ProviderGroup, string>> = {
	oauth: "OAuth subscriptions",
	"api-key": "API keys",
	local: "Local",
};

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
};

/**
 * Group of a login entry, from its compiled auth policy: an API-key paste that accepts an empty answer is a local
 * server; any other API-key paste is a key; browser, device-code and custom flows are subscriptions.
 */
export function providerGroup(providerId: string): ProviderGroup {
	const login = authPolicyFor(providerId)?.login;
	if (login?.kind !== "api-key") return "oauth";
	return login.emptyFallback !== undefined ? "local" : "api-key";
}

interface Entry {
	readonly info: OAuthProviderInfo;
	readonly group: ProviderGroup;
}

/** One rendered row: a group heading, or a provider at `index` of the filtered list. */
type Row =
	| { readonly kind: "heading"; readonly group: ProviderGroup; readonly count: number }
	| { readonly kind: "provider"; readonly index: number };

export class GroupedProviderList implements Component {
	readonly #entries: readonly Entry[];
	readonly #keys: Pick<KeysApi, "source">;
	readonly #onSelect: (providerId: string) => void;
	readonly #onCancel: () => void;
	#query = "";
	#selected = 0;
	#message: string | undefined;
	/** Provider index per body line of the last render (`undefined` for headings and chrome). */
	#lineTargets: (number | undefined)[] = [];

	constructor(
		providers: readonly OAuthProviderInfo[],
		keys: Pick<KeysApi, "source">,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
	) {
		const entries = providers.map(info => ({ info, group: providerGroup(info.id) }));
		this.#entries = PROVIDER_GROUP_ORDER.flatMap(group => entries.filter(entry => entry.group === group));
		this.#keys = keys;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
	}

	invalidate(): void {}

	#visible(): Entry[] {
		const query = this.#query.trim().toLowerCase();
		if (!query) return [...this.#entries];
		return this.#entries.filter(
			entry => entry.info.name.toLowerCase().includes(query) || entry.info.id.toLowerCase().includes(query),
		);
	}

	#origin(entry: Entry): string | undefined {
		const source = this.#keys.source(entry.info.storeCredentialsAs ?? entry.info.id);
		if (!source) return undefined;
		return source.kind === "env" && source.envVar
			? `env: ${source.envVar}`
			: (ORIGIN_LABELS[source.kind] ?? source.kind);
	}

	#move(delta: number, wrap: boolean): void {
		const total = this.#visible().length;
		if (total === 0) return;
		const next = this.#selected + delta;
		this.#selected = wrap ? ((next % total) + total) % total : Math.max(0, Math.min(total - 1, next));
		this.#message = undefined;
	}

	#confirm(): void {
		const entry = this.#visible()[this.#selected];
		if (!entry) return;
		if (!entry.info.available) {
			this.#message = "Provider unavailable in this environment.";
			return;
		}
		this.#message = undefined;
		this.#onSelect(entry.info.id);
	}

	#setQuery(query: string): void {
		this.#query = query;
		this.#selected = 0;
		this.#message = undefined;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) {
			if (this.#query) this.#setQuery("");
			else this.#onCancel();
		} else if (matchesSelectUp(data)) this.#move(-1, true);
		else if (matchesSelectDown(data)) this.#move(1, true);
		else if (matchesKey(data, "pageUp")) this.#move(-10, false);
		else if (matchesKey(data, "pageDown")) this.#move(10, false);
		else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") this.#confirm();
		else if (matchesKey(data, "backspace")) {
			if (this.#query) this.#setQuery([...this.#query].slice(0, -1).join(""));
		} else {
			const printable = extractPrintableText(data);
			if (printable !== undefined && (this.#query || printable.trim())) this.#setQuery(this.#query + printable);
		}
	}

	/** Wheel moves the selection; a click on a provider row signs in to it. */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			this.#move(event.wheel, false);
			return;
		}
		if (!event.leftClick || event.motion) return;
		const target = this.#lineTargets[line];
		if (target === undefined) return;
		this.#selected = target;
		this.#confirm();
	}

	render(width: number, maxLines = 24): string[] {
		const visible = this.#visible();
		if (this.#selected >= visible.length) this.#selected = Math.max(0, visible.length - 1);
		const connected = this.#entries.filter(entry => this.#origin(entry) !== undefined).length;
		const search = this.#query
			? `${theme.fg("accent", "/")} ${theme.fg("text", this.#query)}${theme.fg("muted", ` · ${visible.length} match${visible.length === 1 ? "" : "es"}`)}`
			: theme.fg("muted", `type to filter · ${this.#entries.length} providers · ${connected} connected`);
		const lines = [search, ""];
		const targets: (number | undefined)[] = [undefined, undefined];
		const footer = this.#message ? ["", theme.fg("warning", `! ${this.#message}`)] : [];

		if (visible.length === 0) {
			lines.push(theme.fg("muted", `No provider matches "${this.#query}". Backspace edits, Esc clears.`));
			this.#lineTargets = targets;
			return [...lines, ...footer].map(line => truncateToWidth(line, width));
		}

		const rows: Row[] = [];
		for (const group of PROVIDER_GROUP_ORDER) {
			const indices = visible.flatMap((entry, index) => (entry.group === group ? [index] : []));
			if (indices.length === 0) continue;
			rows.push({ kind: "heading", group, count: indices.length });
			for (const index of indices) rows.push({ kind: "provider", index });
		}
		const budget = Math.max(1, maxLines - lines.length - footer.length);
		const selectedRow = rows.findIndex(row => row.kind === "provider" && row.index === this.#selected);
		let first = Math.max(0, Math.min(selectedRow - Math.floor(budget / 2), rows.length - budget));
		// Keep the selection's group heading on screen when the window would start just below it.
		if (first > 0 && rows[first - 1]?.kind === "heading" && selectedRow - first < budget - 1) first--;
		// Names get the row minus cursor, dot and the `connected · <origin>` status.
		const longest = Math.max(...visible.map(entry => visibleWidth(entry.info.name)));
		const nameWidth = Math.min(longest, Math.max(16, width - 30));
		for (const row of rows.slice(first, first + budget)) {
			if (row.kind === "heading") {
				lines.push(
					`${theme.fg("muted", PROVIDER_GROUP_LABELS[row.group].toUpperCase())} ${theme.fg("dim", `${row.count}`)}`,
				);
				targets.push(undefined);
				continue;
			}
			const entry = visible[row.index]!;
			const selected = row.index === this.#selected;
			const origin = this.#origin(entry);
			const cursor = selected ? theme.fg("accent", `${theme.nav.cursor} `) : "  ";
			const dot = origin ? theme.fg("success", "●") : theme.fg("muted", "○");
			const name = truncateToWidth(entry.info.name, nameWidth);
			const pad = " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
			const label = !entry.info.available
				? theme.fg("dim", name)
				: selected
					? theme.fg("accent", name)
					: theme.fg("text", name);
			const status = origin ? `  ${theme.fg("success", "connected")}${theme.fg("muted", ` · ${origin}`)}` : "";
			lines.push(truncateToWidth(`${cursor}${dot} ${label}${pad}${status}`, width));
			targets.push(row.index);
		}
		this.#lineTargets = targets;
		return [...lines, ...footer].map(line => truncateToWidth(line, width));
	}
}
