#!/usr/bin/env node
// Local GitHub CLI boundary for release publication tests. No network is used.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const root = process.env.FAKE_GH_ROOT;
const statePath = path.join(root, "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
save();
const assets = path.join(root, "assets");
if (process.env.FAKE_GH_DENIED && args[1] === "view") {
  process.stderr.write("HTTP 403: forbidden");
  process.exit(1);
}
if (args[0] === "api" && args[1].includes("/commits/")) {
  process.stdout.write(state.revision);
} else if (args[1] === "view") {
  if (!state.release) {
    process.stderr.write("release not found");
    process.exit(1);
  }
  process.stdout.write(
    JSON.stringify({
      isDraft: state.release.draft,
      tagName: args[2],
      assets: fs.readdirSync(assets).map((name) => ({ name })),
    }),
  );
} else if (args[1] === "create") {
  if (!args.includes("--draft") || !args.includes("--verify-tag"))
    process.exit(2);
  state.release = { draft: true };
  save();
} else if (args[1] === "upload") {
  if (!state.release?.draft || args.includes("--clobber")) process.exit(2);
  for (const file of args.slice(5)) {
    fs.copyFileSync(
      file,
      path.join(assets, path.basename(file)),
      fs.constants.COPYFILE_EXCL,
    );
    if (process.env.FAKE_GH_INTERRUPT_UPLOAD) {
      process.stderr.write("simulated interrupted upload");
      process.exit(1);
    }
  }
} else if (args[1] === "download") {
  const destination = args[args.indexOf("--dir") + 1];
  for (const name of fs.readdirSync(assets)) {
    fs.copyFileSync(path.join(assets, name), path.join(destination, name));
    if (process.env.FAKE_GH_CORRUPT_DOWNLOAD)
      fs.appendFileSync(path.join(destination, name), "corruption");
  }
} else if (args[1] === "edit") {
  if (!args.includes("--draft=false")) process.exit(2);
  state.release.draft = false;
  save();
} else {
  process.stderr.write(`unexpected gh arguments: ${JSON.stringify(args)}`);
  process.exit(2);
}
