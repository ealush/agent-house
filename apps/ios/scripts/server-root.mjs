// Where the ah server these scripts run is: this repository's own (the app lives inside it),
// unless AH_SOURCE names another checkout, e.g. an older host to try the app against.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const serverRoot = () => resolve(process.env.AH_SOURCE ?? fileURLToPath(new URL('../../..', import.meta.url)));
