/**
 * Client-half test scaffolding.
 *
 * `lib/client.js` is a browser bundle: it registers itself with
 * `window.__ModuleLoader__` and takes react + react/jsx-runtime from the host.
 * This module loads those exact bytes with a stub loader, so the suite covers
 * the client half with no browser, no DSH and no network.
 *
 * The stubs are thin on purpose:
 *  - `useState` returns the injected git-status payload while preserving the key
 *    `useGitStatus` matches on, so no fetch, cache or EventSource is involved;
 *  - `useEffect` is a no-op, so the poll/stream machinery never starts;
 *  - `jsx`/`jsxs` return plain `{ type, props }` objects.
 * `expand()` then does React's job of calling function components, so a test
 * sees the element tree the DOM would.
 *
 * Adapted from the shape the suite already uses for the node half: real code,
 * fake host. No DSH involvement.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

/** Call function components the way React would; leave host elements alone. */
export function expand(node) {
	if (node === null || node === void 0) return node;
	if (Array.isArray(node)) return node.map(expand);
	if (typeof node === "object" && node.props !== void 0) {
		if (typeof node.type === "function") return expand(node.type(node.props));
		return { ...node, props: { ...node.props, children: expand(node.props.children) } };
	}
	return node;
}

/** Every element in an expanded tree, in document order. */
export function elements(node, out = []) {
	if (Array.isArray(node)) {
		for (const child of node) elements(child, out);
		return out;
	}
	if (node !== null && typeof node === "object" && node.props !== void 0) {
		out.push(node);
		elements(node.props.children, out);
	}
	return out;
}

/** Concatenated text of an expanded tree. */
export function text(node) {
	if (node === null || node === void 0) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(text).join("");
	if (typeof node === "object" && node.props !== void 0) return text(node.props.children);
	return "";
}

/** A host element's children as an array, whatever shape it was built with. */
export function children(element) {
	const kids = element.props.children;
	if (kids === void 0 || kids === null) return [];
	return Array.isArray(kids) ? kids : [kids];
}

/** The single <svg> status mark in an expanded tree, or null. */
export function mark(node) {
	return elements(node).find((element) => element.type === "svg") ?? null;
}

/** "disc" or "tree" — the shape that carries worktree-ness. */
export function markShape(svg) {
	return children(svg).some((child) => child.type === "rect") ? "tree" : "disc";
}

/** The disc/crown fill — the status colour. */
export function markFill(svg) {
	return children(svg).find((child) => child.type === "circle")?.props.fill;
}

/**
 * Load the real client bundle and return a renderer per registered surface.
 * `apply()` is driven with a fake slots service that captures each registration
 * by slot name.
 */
export function createClient() {
	const source = readFileSync(CLIENT, "utf8");
	const injected = { data: void 0 };
	let captured = null;
	const element = (type, props) => ({ type, props });
	const react = {
		useState: (initial) => [{ key: initial.key, data: injected.data }, () => {}],
		useEffect: () => {}
	};
	const jsxRuntime = { jsx: element, jsxs: element, Fragment: "Fragment" };
	const fakeRequire = (id) => (id === "react/jsx-runtime" ? jsxRuntime : react);
	new Function("window", "require", source)(
		{ __ModuleLoader__: { load: (module) => { captured = module; } } },
		fakeRequire
	);

	const registered = {};
	const info = console.info;
	// apply() reports which surfaces it found; that is boot logging, not test output
	console.info = () => {};
	try {
		captured.factory(fakeRequire).apply({
			slots: {
				inject: (_name, callback) => { callback(); },
				register: (spec, component) => {
					registered[spec.name] = component;
					return () => {};
				},
				spec: () => void 0
			}
		});
	} finally {
		console.info = info;
	}

	// `git: true` is the node half's "this is a repository" marker; a payload that
	// names `git` itself (e.g. { git: false }) wins, so non-repo cases are testable
	const payload = (data) => (data === void 0 ? void 0 : { git: true, ...data });
	return {
		/** Render the sidebar row. */
		row(data, label = "project") {
			injected.data = payload(data);
			return expand(registered["sidebar.workspaces.row"]({ label, workspaceId: "ws-1" }));
		},
		/** Render the composer chip. */
		chip(data) {
			injected.data = payload(data);
			return expand(registered["conversation.input.left"]({ sessionId: "s-1" }));
		}
	};
}
