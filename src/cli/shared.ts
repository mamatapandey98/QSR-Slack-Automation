/**
 * Runs a CLI entry point, turning expected failures (stale session, missing config) into a
 * readable message instead of a stack trace. Pass --debug to see the full error.
 */
export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (process.argv.includes("--debug")) {
      console.error(error);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n${message}\n`);
      console.error("(re-run with --debug for the full stack trace)");
    }
    process.exitCode = 1;
  }
}
