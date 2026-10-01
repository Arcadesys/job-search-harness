import { startJobdesk } from '../../services/jobdesk/server';
async function main() {
  if (!process.env.JOBDESK_TEST_ROOT) throw new Error('Private test directory required.');
  const runtime = await startJobdesk({ root: process.env.JOBDESK_TEST_ROOT });
  console.log(JSON.stringify({ origin: runtime.origin, socketPath: runtime.socketPath }));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
