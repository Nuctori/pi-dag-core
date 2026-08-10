/**
 * CI smoke check: the shipped example spec must validate.
 */
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec.js";

const spec = readFileSync(
	new URL("../examples/code-review.json", import.meta.url),
	"utf8",
);
const res = parseSpec(spec);
if (!res.ok) {
	console.error("example spec invalid:", res.issues);
	process.exit(1);
}
console.log("example spec valid");
