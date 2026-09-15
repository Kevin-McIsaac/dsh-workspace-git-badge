/**
 * The settings namespace and the card's reorder helper.
 *
 * The card itself is host-rendered (Settings → Plugins); what this file proves
 * is the contract underneath it: the node half registers the `git-badge`
 * namespace with the category schema, seeds it from the pre-settings JSON file,
 * follows the scope live, and the client half's reorder primitive behaves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, config, nextStep } from "../lib/index.js";

/** A schemastery-shaped stub: enough for the namespace schema to resolve. */
function stubSchema() {
	// schemastery chains: array(x).default(v), union(values), object({...})
	const chained = (value, extra = {}) => ({
		_default: value,
		default: (next) => chained(next, extra),
		...extra
	});
	return {
		object: (fields) => ({
			_defaults: Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field._default]))
		}),
		array: (inner) => chained(inner?._default ?? []),
		union: (values) => chained(values[0], { _values: values })
	};
}

/** A fake cordis ctx: records slot/service registrations, runs inject callbacks. */
function fakeCtx({ order } = {}) {
	const registered = { namespaces: [], orders: [], settings: undefined };
	const scope = {
		get: () => ({ order: order ?? ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"] }),
		watch: () => () => {}
	};
	const ctx = {
		effect: (fn) => fn(),
		webServer: { register: () => () => {} },
		workspaceRegistry: { resolve: () => void 0 },
		inject: (names, callback) => {
			if (!names.includes("settings")) return;
			callback({
				settings: {
					register: (ns, schema, options) => {
						registered.namespaces.push(ns);
						registered.schemas = registered.schemas ?? [];
						registered.schemas.push(schema);
						registered.orders.push(options?.base?.order);
						registered.settings = { ns, options };
						return scope;
					}
				},
				effect: (fn) => fn()
			});
		}
	};
	return { ctx, registered };
}

test("the node half registers the git-badge namespace with the category schema", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-git-badge-settings-"));
	const previousHome = process.env.DSH_HOME;
	const previousLoader = config.settingsSchemaLoader;
	process.env.DSH_HOME = home;
	config.settingsSchemaLoader = async () => stubSchema();
	try {
		const { ctx, registered } = fakeCtx();
		apply(ctx);
		// wait for the async inject callback to settle
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(registered.namespaces, ["git-badge"]);
		const schema = registered.schemas[0];
		assert.deepEqual(schema._defaults.order, ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"]);
	} finally {
		config.settingsSchemaLoader = previousLoader;
		if (previousHome === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("a pre-settings JSON file seeds the namespace base", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-git-badge-legacy-"));
	const previousHome = process.env.DSH_HOME;
	const previousLoader = config.settingsSchemaLoader;
	process.env.DSH_HOME = home;
	config.settingsSchemaLoader = async () => stubSchema();
	writeFileSync(join(home, "git-badge-next.json"), JSON.stringify({ order: ["commit", "sync"] }));
	try {
		const { ctx, registered } = fakeCtx();
		apply(ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(registered.orders[0], ["commit", "sync", "operation", "unmerged", "publish", "merge", "checks"], "the file's order, normalised");
	} finally {
		config.settingsSchemaLoader = previousLoader;
		if (previousHome === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("a live scope order is what nextStep ranks by", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-git-badge-live-"));
	const previousHome = process.env.DSH_HOME;
	const previousLoader = config.settingsSchemaLoader;
	process.env.DSH_HOME = home;
	config.settingsSchemaLoader = async () => stubSchema();
	try {
		// default order ranks sync before commit; the namespace serves the reverse
		const { ctx } = fakeCtx({ order: ["commit", "sync"] });
		apply(ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const next = nextStep({ git: true, upstream: "o/m", behind: 2, stagedFiles: 1 });
		assert.equal(next.args, "commit", "the namespace order wins once registered");
	} finally {
		config.settingsSchemaLoader = previousLoader;
		if (previousHome === void 0) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

// ---------------------------------------------------------------------------
// the card's reorder primitive (client half, pure)
// ---------------------------------------------------------------------------

test("moveCategory swaps neighbours, is immutable, and no-ops at the ends", async () => {
	const { createClient } = await import("../test-support/client.mjs");
	const { moveCategory } = createClient().internals;
	const order = ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"];
	assert.deepEqual(moveCategory(order, 2, -1), ["operation", "sync", "unmerged", "publish", "merge", "commit", "checks"], "up");
	assert.deepEqual(moveCategory(order, 2, 1), ["operation", "unmerged", "publish", "sync", "merge", "commit", "checks"], "down");
	assert.deepEqual(moveCategory(order, 0, -1), order, "top cannot move up");
	assert.deepEqual(moveCategory(order, order.length - 1, 1), order, "bottom cannot move down");
	assert.deepEqual(moveCategory(order, 99, 1), order, "out of range is a no-op");
	assert.deepEqual(order, ["operation", "unmerged", "sync", "publish", "merge", "commit", "checks"], "the input is never mutated");
});
