#!/usr/bin/env node
import { createInterface } from "node:readline";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
emit({ ready: true });
if (process.argv.includes("--check")) process.exit(0);
let path = "";
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "load") { path = request.path; emit({ done: true }); return; }
  const text = request.body.messages.at(-1).content;
  if (text.includes("wait forever")) return;
  if (text.includes("crash worker")) process.exit(1);
  emit({ delta: { content: `Local fixture: ${text} (${path.split("/").at(-1)})` } });
  emit({ done: true, finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 8 } });
});
