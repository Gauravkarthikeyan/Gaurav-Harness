#!/usr/bin/env bun
/**
 * gk: brand audit. Fails when user-visible text still names the upstream product.
 *
 * Scans packages/*\/src/**\/*.{ts,md} (test files excluded). In .ts files only string
 * literals and template-literal text are checked; module specifiers (import/export/require/
 * dynamic import/declare module) are code, not text, and are skipped. In .md files every
 * line is prompt/doc text and is checked.
 *
 * Allowlist: scripts/gk-brand-allowlist.txt, one entry per line:
 *   <glob>[#<needle>]: <reason>
 * A hit is allowed when its file matches <glob> and, if a needle is given, its literal contains
 * the needle; a needle written as /<regex>/ is tested as a regular expression instead.
 *
 * Usage: bun scripts/gk-brand-audit.ts [--verbose]
 */
import * as path from "node:path";
import { parse } from "@babel/parser";
import type * as t from "@babel/types";

const ROOT = path.resolve(import.meta.dir, "..");
const PATTERN = /\bomp\b|oh-my-pi|oh my pi|omp\.sh|Stencil/i;
const ALLOWLIST_PATH = path.join(ROOT, "scripts/gk-brand-allowlist.txt");

interface Hit {
	file: string;
	line: number;
	text: string;
}

interface AllowEntry {
	glob: Bun.Glob;
	pattern: string;
	needle?: string | RegExp;
	reason: string;
	used: number;
}

/** Module specifier positions: package/file names, never shown to users. */
function moduleSpecifierStarts(node: t.Node): number | undefined {
	switch (node.type) {
		case "ImportDeclaration":
		case "ExportAllDeclaration":
		case "ExportNamedDeclaration":
			return node.source?.start ?? undefined;
		case "TSImportType":
			return node.argument.start ?? undefined;
		case "TSExternalModuleReference":
			return node.expression.start ?? undefined;
		case "TSModuleDeclaration":
			return node.id.type === "StringLiteral" ? (node.id.start ?? undefined) : undefined;
		case "CallExpression": {
			const callee = node.callee;
			const first = node.arguments[0];
			if (!first) return undefined;
			const isLoader =
				callee.type === "Import" ||
				(callee.type === "Identifier" && callee.name === "require") ||
				(callee.type === "MemberExpression" &&
					callee.property.type === "Identifier" &&
					callee.property.name === "resolve" &&
					((callee.object.type === "Identifier" && callee.object.name === "require") ||
						callee.object.type === "MetaProperty"));
			return isLoader ? (first.start ?? undefined) : undefined;
		}
		case "ImportExpression":
			return node.source.start ?? undefined;
		default:
			return undefined;
	}
}

function scanTs(rel: string, source: string): Hit[] {
	const ast = parse(source, {
		sourceType: "module",
		plugins: ["typescript", "decorators", "importAttributes"],
		errorRecovery: true,
	});
	const hits: Hit[] = [];
	const skip = new Set<number>();
	const visit = (node: t.Node): void => {
		const specifier = moduleSpecifierStarts(node);
		if (specifier !== undefined) skip.add(specifier);
		let text: string | undefined;
		if (node.type === "StringLiteral") text = node.value;
		else if (node.type === "TemplateElement") text = node.value.cooked ?? node.value.raw;
		if (text !== undefined && !skip.has(node.start ?? -1) && PATTERN.test(text)) {
			hits.push({ file: rel, line: node.loc?.start.line ?? 0, text });
		}
		for (const key of Object.keys(node) as (keyof t.Node)[]) {
			if (key === "loc" || key === "leadingComments" || key === "trailingComments" || key === "innerComments")
				continue;
			const value = node[key] as unknown;
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child.type === "string") visit(child);
			} else if (value && typeof (value as t.Node).type === "string") visit(value as t.Node);
		}
	};
	visit(ast.program);
	return hits;
}

function scanMd(rel: string, source: string): Hit[] {
	const hits: Hit[] = [];
	source.split("\n").forEach((text, index) => {
		if (PATTERN.test(text)) hits.push({ file: rel, line: index + 1, text });
	});
	return hits;
}

async function loadAllowlist(): Promise<AllowEntry[]> {
	const file = Bun.file(ALLOWLIST_PATH);
	if (!(await file.exists())) return [];
	const entries: AllowEntry[] = [];
	for (const raw of (await file.text()).split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const sep = line.indexOf(": ");
		if (sep < 0) throw new Error(`gk-brand-allowlist: missing ": <reason>" in line: ${line}`);
		const spec = line.slice(0, sep);
		const reason = line.slice(sep + 2).trim();
		const hashAt = spec.indexOf("#");
		const pattern = hashAt < 0 ? spec : spec.slice(0, hashAt);
		const needleSpec = hashAt < 0 ? undefined : spec.slice(hashAt + 1);
		const isRegex =
			needleSpec !== undefined && needleSpec.length > 2 && needleSpec.startsWith("/") && needleSpec.endsWith("/");
		const needle = isRegex ? new RegExp(needleSpec.slice(1, -1)) : needleSpec;
		entries.push({ glob: new Bun.Glob(pattern), pattern: spec, needle, reason, used: 0 });
	}
	return entries;
}

async function main(): Promise<number> {
	const verbose = process.argv.includes("--verbose");
	const allow = await loadAllowlist();
	const hits: Hit[] = [];
	const glob = new Bun.Glob("packages/*/src/**/*.{ts,md}");
	for await (const rel of glob.scan({ cwd: ROOT, onlyFiles: true })) {
		const isTest = /\.test\.ts$/.test(rel) || /(^|\/)(test|tests|__tests__|fixtures)\//.test(rel);
		if (isTest || rel.endsWith(".d.ts")) continue;
		const source = await Bun.file(path.join(ROOT, rel)).text();
		if (!PATTERN.test(source)) continue;
		hits.push(...(rel.endsWith(".md") ? scanMd(rel, source) : scanTs(rel, source)));
	}

	const failures: Hit[] = [];
	for (const hit of hits) {
		const entry = allow.find(
			e =>
				e.glob.match(hit.file) &&
				(e.needle === undefined ||
					(typeof e.needle === "string" ? hit.text.includes(e.needle) : e.needle.test(hit.text))),
		);
		if (entry) entry.used++;
		else failures.push(hit);
	}

	failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	for (const hit of failures) {
		const snippet = hit.text.replace(/\s+/g, " ").trim().slice(0, 140);
		console.log(`${hit.file}:${hit.line}: ${snippet}`);
	}
	const unused = allow.filter(e => e.used === 0);
	for (const entry of unused) console.log(`unused allowlist entry: ${entry.pattern}`);
	if (verbose) for (const entry of allow) console.log(`allowed ${entry.used}× ${entry.pattern} — ${entry.reason}`);

	const allowed = hits.length - failures.length;
	console.log(
		`gk-brand-audit: ${failures.length} hit(s), ${allowed} allowlisted, ${unused.length} unused allowlist entr${unused.length === 1 ? "y" : "ies"}`,
	);
	return failures.length > 0 || unused.length > 0 ? 1 : 0;
}

process.exit(await main());
