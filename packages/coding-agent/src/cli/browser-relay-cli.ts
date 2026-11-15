/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import { defaultRelayExtensionDir, writeRelayExtension } from "../tools/browser/relay/extension-files";
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}

async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : defaultRelayExtensionDir();
	await writeRelayExtension(dir, VERSION);
	console.log(`Installed the browser relay extension to ${dir}`); // gk: debrand
	console.log("");
	console.log("Finish setup in Chrome:");
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	console.log("  3. Enable the mode:  gk config set browser.relay true"); // gk: debrand
	console.log("");
	console.log("GK Code starts the relay automatically when the browser prelude needs it;"); // gk: debrand
	console.log("run `gk browser-relay` yourself only for --token or --no-group."); // gk: debrand
	console.log("The extension badge shows 'on' once it reaches a relay.");
	if (!dirOverride) console.log("Newer GK Code versions update the extension in this folder and reload it on their own."); // gk: debrand
	console.log(
		"Old connection-refused entries in chrome://extensions > Errors may persist after reconnect; use Clear all.",
	);
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	let relay: RelayServer;
	try {
		relay = startRelayServer({ port: args.port, token: args.token, group: args.group !== false, log });
	} catch (err) {
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(`GK Code browser relay already running on http://127.0.0.1:${args.port}; nothing to do.`); // gk: debrand
				return;
			}
			console.error(`Port ${args.port} is in use by something that is not a GK Code browser relay.`); // gk: debrand
			process.exit(1);
		}
		throw err;
	}

	console.log(`GK Code browser relay listening on http://127.0.0.1:${args.port}`); // gk: debrand
	console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log("  enable with         gk config set browser.relay true"); // gk: debrand
	} else {
		console.log(
			`  enable with         gk config set browser.relay true && gk config set browser.relayUrl http://127.0.0.1:${args.port}`, // gk: debrand
		);
	}
	console.log("Waiting for the browser relay extension to connect (gk browser-relay install)..."); // gk: debrand

	let announced = false;
	const readiness = setInterval(() => {
		if (relay.bridge.ready && !announced) {
			announced = true;
			console.log("Extension connected. The GK Code browser prelude can now drive your tabs."); // gk: debrand
		} else if (!relay.bridge.ready && announced) {
			announced = false;
			console.log("Extension disconnected; waiting for it to reconnect...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		relay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
