// unknot daemon [--port N] — start the optional API daemon (spec §24).
// Prints where to connect and where the token lives; never the token itself.

import { createDaemon } from '../../daemon/server.mjs';
import { UnknotError } from '../../core/errors.mjs';
import { output } from '../util.mjs';
import { open } from './_shared.mjs';

export async function run({ flags }) {
  const { ctx, config } = open(flags);
  let port;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UnknotError('UK_CONFIG_INVALID', '--port must be an integer between 0 and 65535');
  }
  const daemon = createDaemon({ root: ctx.root, config, port, onError: (err) => process.stderr.write(`unknot daemon: internal error: ${err?.message ?? err}\n`) });
  const { url } = await daemon.listen();
  const info = { url, mode: daemon.mode, token_file: daemon.tokenFile };
  output(
    flags.json
      ? info
      : [`Unknot API daemon (${daemon.mode} mode) listening on ${url}`, daemon.tokenFile ? `Bearer token file: ${daemon.tokenFile} (mode 0600; send it as "Authorization: Bearer <contents>")` : 'Authentication: mutual TLS client certificate + OIDC bearer token', 'Press Ctrl+C to stop.'].join('\n'),
    { json: flags.json },
  );
  // Stay alive until signalled; closing the server lets the process exit cleanly.
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await daemon.close();
  return 0;
}
