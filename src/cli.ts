import { runCli } from "./cli-app";

// A closed pipe (e.g. `ccsl --json | head`) is not an error worth a stack trace.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

runCli(process.argv.slice(2)).then(
  (code) => {
    // exitCode (not process.exit) so large piped output is flushed first.
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`ccsl: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
