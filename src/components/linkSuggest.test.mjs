// Self-check for linkSuggest.ts, run by `pnpm test:editor` (plain Node, which strips the types on import).

import assert from "node:assert/strict";
import { headingsOf, linkQuery, matchScore, splitLink, subpathLine, suggestFiles } from "./linkSuggest.ts";

// The link being typed.
assert.deepEqual(linkQuery("see [[Pro"), { embed: false, start: 6, name: "Pro", heading: null });
assert.deepEqual(linkQuery("[["), { embed: false, start: 2, name: "", heading: null });
assert.deepEqual(linkQuery("![[pic"), { embed: true, start: 3, name: "pic", heading: null });
assert.deepEqual(linkQuery("[[Plan#Go"), { embed: false, start: 2, name: "Plan", heading: { start: 7, text: "Go" } });
assert.deepEqual(linkQuery("[[#"), { embed: false, start: 2, name: "", heading: { start: 3, text: "" } });
assert.equal(linkQuery("[[Plan]] and"), null);
assert.equal(linkQuery("[[Plan|ali"), null);
assert.equal(linkQuery("[[Plan#^blo"), null);
assert.equal(linkQuery("[[Plan#A#B"), null);
assert.equal(linkQuery("[one"), null);
// The last `[[` on the line counts.
assert.equal(linkQuery("[[a]] [[b")?.name, "b");

// Ranking: exact, start, word start, inside, letters in order.
assert.equal(matchScore("plan", "plan"), 0);
assert.equal(matchScore("planning", "plan"), 1);
assert.equal(matchScore("my plan", "plan"), 2);
assert.equal(matchScore("airplane", "plan"), 3);
assert.ok(matchScore("project log", "pjl") > 4);
assert.ok(matchScore("pjl xxxxxxxxx", "pjl") < matchScore("project log", "pjl"));
assert.equal(matchScore("plan", "nalp"), null);

const vault = ["Plan.md", "Projects/Plan.md", "Projects/Planning.md", "Airplane.md", "Daily/2026-01-05.md", "img/plan.png", "Home.md"];
const plan = suggestFiles(vault, "plan", false);
assert.deepEqual(
  plan.map((s) => s.path),
  ["Plan.md", "Projects/Plan.md", "Projects/Planning.md", "Airplane.md"],
);
// Two notes named Plan: each is linked by its path and shows its folder; a name of its own shows no folder.
assert.deepEqual(plan[0], { path: "Plan.md", link: "Plan", label: "Plan", folder: "/" });
assert.deepEqual(plan[1], { path: "Projects/Plan.md", link: "Projects/Plan", label: "Plan", folder: "Projects" });
assert.deepEqual(plan[2], { path: "Projects/Planning.md", link: "Planning", label: "Planning", folder: "" });
// An embed offers every file, an image by its name with the extension.
assert.deepEqual(
  suggestFiles(vault, "plan.p", true).map((s) => s.link),
  ["plan.png"],
);
assert.ok(suggestFiles(vault, "plan", true).some((s) => s.path === "img/plan.png"));
assert.ok(!plan.some((s) => s.path === "img/plan.png"));
// A query with a slash matches the path; no query lists the shortest names first.
assert.deepEqual(
  suggestFiles(vault, "projects/pl", false).map((s) => s.path),
  ["Projects/Plan.md", "Projects/Planning.md"],
);
assert.equal(suggestFiles(vault, "", false)[0].path, "Home.md");
assert.equal(suggestFiles(vault, "", false, 2).length, 2);

// Headings, without frontmatter and fenced code.
const note = [
  "---",
  "title: # not a heading",
  "---",
  "# Top",
  "text ^intro",
  "## Next Steps ##",
  "```sh",
  "# a comment",
  "```",
  "### Deep",
  "#tag is not a heading",
  "- item ^list-1",
].join("\n");
assert.deepEqual(headingsOf(note), [
  { level: 1, text: "Top", line: 4 },
  { level: 2, text: "Next Steps", line: 6 },
  { level: 3, text: "Deep", line: 10 },
]);
assert.deepEqual(headingsOf("```\n# in code\n"), []);
assert.deepEqual(headingsOf("~~~~\n```\n# in code\n~~~~\n# Out"), [{ level: 1, text: "Out", line: 5 }]);

// Link parts.
assert.deepEqual(splitLink("Plan#Next|see"), { name: "Plan", subpath: "Next" });
assert.deepEqual(splitLink("#Top"), { name: "", subpath: "Top" });
assert.deepEqual(splitLink("Plan"), { name: "Plan", subpath: "" });
assert.deepEqual(splitLink("Plan#A#B"), { name: "Plan", subpath: "A#B" });

// Where a subpath points: a heading in any case, the last of nested ones, or a block id at the end of a line.
assert.equal(subpathLine(note, "next steps"), 6);
assert.equal(subpathLine(note, "Top#Deep"), 10);
assert.equal(subpathLine(note, "  Next   Steps "), 6);
assert.equal(subpathLine(note, "a comment"), null);
assert.equal(subpathLine(note, "Missing"), null);
assert.equal(subpathLine(note, "^intro"), 5);
assert.equal(subpathLine(note, "^list-1"), 12);
assert.equal(subpathLine(note, "^tro"), null);
assert.equal(subpathLine(note, "^"), null);
assert.equal(subpathLine(note, ""), null);
assert.equal(subpathLine("a\r\n## B\r\n", "b"), 2);

console.log("linkSuggest: ok");
