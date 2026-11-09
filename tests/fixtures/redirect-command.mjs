// Preloaded with `node --import` into a script under test. Routes the script's
// spawnSync calls of one external command to a local fake script, which still
// runs as a real child process through the same arguments and options.
//
// A fake placed first on PATH is not portable: on Windows, libuv resolves a bare
// command only as `.com` or `.exe`, so an extensionless shebang shim is never
// found and the developer's real tool runs instead. npm is also resolved on
// Windows as npm-cli.js beside the Node executable rather than from PATH.
//
// KRX_TEST_COMMAND_REDIRECT is JSON: { command, argumentPrefix, script }. A call
// is redirected only when it spawns `command` with `argumentPrefix` first; the
// fake receives the remaining arguments.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

const { command, argumentPrefix, script } = JSON.parse(
  process.env.KRX_TEST_COMMAND_REDIRECT,
);
const spawnSync = childProcess.spawnSync;

childProcess.spawnSync = (file, args, options) => {
  const redirected =
    file === command &&
    Array.isArray(args) &&
    argumentPrefix.every((argument, index) => args[index] === argument);
  return redirected
    ? spawnSync(
        process.execPath,
        [script, ...args.slice(argumentPrefix.length)],
        options,
      )
    : spawnSync(file, args, options);
};
// Rebind `import { spawnSync } from "node:child_process"` in the script under test.
syncBuiltinESMExports();
