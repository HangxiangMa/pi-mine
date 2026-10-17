import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";

// Same tiny runner as the other suites: collect cases, run them, print ok/FAIL, exit non-zero on failure.
const tests = [];
function it(name, body) {
	tests.push({ name, body });
}

// formatConfigStatus used to have no caller, so nothing ever displayed it. The status command must
// be registered and must call it, so a user can actually see the state.
it("a /config-status command is registered in the extension entry point", () => {
	const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
	assert.match(source, /registerCommand\(\s*"config-status"/, "the command is registered");
});

it("the /config-status handler shows formatConfigStatus() to the user", () => {
	const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
	const handler = source.match(/registerCommand\(\s*"config-status"[\s\S]*?\n\t\}\);/);
	assert.ok(handler, "the /config-status registration block is present");
	assert.match(handler[0], /formatConfigStatus\(\)/, "the handler calls formatConfigStatus");
	assert.match(handler[0], /ctx\.ui\.notify\(/, "the result is shown through the UI");
});

it("the status line lists every switch that the config defines", () => {
	const text = formatConfigStatus({ ...DEFAULT_CONFIG });
	for (const key of ["idleRecap", "hooks", "permissions", "metrics"]) {
		assert.match(text, new RegExp(`\\b${key}=(on|off)\\b`), `${key} is in the status line`);
	}
});

let failed = 0;
for (const { name, body } of tests) {
	try {
		body();
		console.log(`ok  ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${name}\n     ${error.message.split("\n")[0]}`);
	}
}
console.log(`config-status-command: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
