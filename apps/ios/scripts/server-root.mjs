// Where the ah server these scripts run is: this repository's own (apps/server, beside the app),
// unless AH_SOURCE names another server: the folder with its server/ and test/ — a checkout's
// apps/server, or the root of an ah from before the move.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverRoot = () => resolve(process.env.AH_SOURCE ?? fileURLToPath(new URL('../../server', import.meta.url)));
