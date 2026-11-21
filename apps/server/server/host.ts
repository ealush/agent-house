// This host's name: what it's called in `hosts`, in session records, under /h/<name>/,
// and what peers address it by. The OS hostname, unless AH_HOSTNAME names it (two ah
// daemons on one machine, as the migration tests run them, need distinct names).
import { hostname } from 'node:os';

const NAME = /^[\w.-]{1,64}$/;

export function hostName(): string {
  const override = process.env.AH_HOSTNAME?.trim();
  return override && NAME.test(override) ? override : hostname();
}
