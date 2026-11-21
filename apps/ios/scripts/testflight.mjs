#!/usr/bin/env node
// A TestFlight build from anywhere: starts the Xcode Cloud workflow on a branch and waits until
// the build is in internal testing. Apple's App Store Connect API, nothing else; no package to
// install, and the key never leaves this machine.
//
//   node scripts/testflight.mjs check                  # the key works; the app, its workflows, groups
//   node scripts/testflight.mjs group <email>          # the internal group, with you in it
//   node scripts/testflight.mjs ship [branch] [--wait] # a build of the branch's head (default main)
//   node scripts/testflight.mjs wait <run id>          # until that run's build is in TestFlight
//
// The key: an App Store Connect API key (Users and Access → Integrations, App Manager), kept out
// of the repository. ~/.config/ah-native/app-store-connect.json says where it is:
//   { "keyId": "…", "issuerId": "…", "keyPath": "~/.config/ah-native/AuthKey_….p8" }
// or ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH do. AH_WORKFLOW names the workflow to run when
// the product has more than one (by default, the one whose name says TestFlight).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUNDLE_ID = 'dev.ealush.ah.native';
const GROUP = 'Internal';
const API = 'https://api.appstoreconnect.apple.com';

const home = (p) => p.replace(/^~(?=\/)/, homedir());
/** Read once, at the first request: a mistyped command says so before any key is asked for. */
let loaded;
const config = () => (loaded ??= (() => {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), '.config/ah-native/app-store-connect.json'), 'utf8'));
  } catch {}
  const keyId = process.env.ASC_KEY_ID ?? file.keyId;
  const issuerId = process.env.ASC_ISSUER_ID ?? file.issuerId;
  const keyPath = process.env.ASC_KEY_PATH ?? file.keyPath;
  if (!keyId || !issuerId || !keyPath) {
    console.error('No App Store Connect key: write ~/.config/ah-native/app-store-connect.json (see the top of this script).');
    process.exit(2);
  }
  return { keyId, issuerId, key: createPrivateKey(readFileSync(home(keyPath))) };
})());

/** A token for 15 minutes (Apple takes at most 20). */
let token = { value: '', until: 0 };
function bearer() {
  const now = Math.floor(Date.now() / 1000);
  if (token.until - 60 > now) return token.value;
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${part({ alg: 'ES256', kid: config().keyId, typ: 'JWT' })}.${part({ iss: config().issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`;
  const signature = sign('sha256', Buffer.from(body), { key: config().key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  token = { value: `${body}.${signature}`, until: now + 900 };
  return token.value;
}

async function api(method, path, body) {
  const response = await fetch(path.startsWith('http') ? path : API + path, {
    method,
    headers: { Authorization: `Bearer ${bearer()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const why = (json.errors ?? []).map((e) => `${e.title}: ${e.detail}`).join('; ') || text;
    throw new Error(`${method} ${path} → ${response.status} ${why}`);
  }
  return json;
}

/** Every page of a list. */
async function all(path) {
  const items = [];
  for (let next = path; next; ) {
    const page = await api('GET', next);
    items.push(...page.data);
    next = page.links?.next;
  }
  return items;
}

async function app() {
  const [found] = (await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}`)).data.filter((a) => a.attributes.bundleId === BUNDLE_ID);
  if (!found) throw new Error(`No app with bundle ID ${BUNDLE_ID} in App Store Connect yet: Xcode Cloud's first setup in Xcode makes it.`);
  return found;
}

async function workflow(appId) {
  const product = (await api('GET', `/v1/apps/${appId}/ciProduct`)).data;
  const flows = await all(`/v1/ciProducts/${product.id}/workflows`);
  const named = process.env.AH_WORKFLOW;
  const pick = named ? flows.filter((w) => w.attributes.name === named) : flows.length === 1 ? flows : flows.filter((w) => /testflight/i.test(w.attributes.name));
  if (pick.length !== 1) throw new Error(`Which workflow? ${flows.map((w) => `"${w.attributes.name}"`).join(', ') || 'none yet'} (set AH_WORKFLOW).`);
  return pick[0];
}

const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

async function check() {
  const a = await app();
  console.log(`app: ${a.attributes.name} (${a.id}), ${a.attributes.bundleId}`);
  try {
    const product = (await api('GET', `/v1/apps/${a.id}/ciProduct`)).data;
    for (const w of await all(`/v1/ciProducts/${product.id}/workflows`)) console.log(`workflow: ${w.attributes.name} (${w.id})${w.attributes.isEnabled ? '' : ', disabled'}`);
  } catch (error) {
    console.log(`no Xcode Cloud product yet (${error.message})`);
  }
  for (const g of await all(`/v1/apps/${a.id}/betaGroups`)) {
    console.log(`group: ${g.attributes.name}, ${g.attributes.isInternalGroup ? 'internal' : 'EXTERNAL'}${g.attributes.hasAccessToAllBuilds ? ', every build' : ''}`);
  }
}

/** The internal group, getting every build, with the account at `email` in it. Never an external one. */
async function group(email) {
  if (!email) throw new Error('group <email>: the Apple Account that installs the builds.');
  const a = await app();
  let g = (await all(`/v1/apps/${a.id}/betaGroups`)).find((x) => x.attributes.isInternalGroup && x.attributes.name === GROUP);
  if (!g) {
    g = (await api('POST', '/v1/betaGroups', {
      data: { type: 'betaGroups', attributes: { name: GROUP, isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: 'apps', id: a.id } } } },
    })).data;
    console.log(`made the internal group "${GROUP}"`);
  }
  const testers = await all(`/v1/betaGroups/${g.id}/betaTesters`);
  if (testers.some((t) => t.attributes.email?.toLowerCase() === email.toLowerCase())) {
    console.log(`${email} is in "${GROUP}"`);
    return;
  }
  // An internal tester is a user of the team: App Store Connect turns down an email that isn't one.
  await api('POST', '/v1/betaTesters', {
    data: { type: 'betaTesters', attributes: { email }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: g.id }] } } },
  });
  console.log(`added ${email} to "${GROUP}"`);
}

async function ship(branch = 'main', wait = false) {
  const a = await app();
  const w = await workflow(a.id);
  const repo = (await api('GET', `/v1/ciWorkflows/${w.id}/repository`)).data;
  const ref = (await all(`/v1/scmRepositories/${repo.id}/gitReferences?limit=200`)).find((r) => r.attributes.kind === 'BRANCH' && r.attributes.name === branch);
  if (!ref) throw new Error(`Xcode Cloud doesn't see a branch "${branch}" (pushed to GitHub?).`);
  const run = (await api('POST', '/v1/ciBuildRuns', {
    data: { type: 'ciBuildRuns', relationships: { workflow: { data: { type: 'ciWorkflows', id: w.id } }, sourceBranchOrTag: { data: { type: 'scmGitReferences', id: ref.id } } } },
  })).data;
  console.log(`started build ${run.attributes.number} of ${branch} on "${w.attributes.name}" (run ${run.id})`);
  if (wait) await until(run.id);
}

/** The run, then its build's processing, then its internal testing: done when you can install it. */
async function until(runId) {
  if (!runId) throw new Error('wait <run id>');
  let said = '';
  const say = (s) => s !== said && console.log((said = s));
  for (;;) {
    const run = (await api('GET', `/v1/ciBuildRuns/${runId}`)).data.attributes;
    say(`run ${run.number}: ${run.executionProgress.toLowerCase()}${run.completionStatus ? `, ${run.completionStatus.toLowerCase()}` : ''}`);
    if (run.executionProgress === 'COMPLETE') {
      if (run.completionStatus !== 'SUCCEEDED') throw new Error(`run ${run.number} ${run.completionStatus}: see Xcode Cloud's log in App Store Connect.`);
      break;
    }
    await sleep(30);
  }
  let build;
  for (let i = 0; !build; i++) {
    build = (await api('GET', `/v1/ciBuildRuns/${runId}/builds`)).data[0];
    if (!build) {
      if (i > 20) throw new Error('The run succeeded but no build reached App Store Connect: does the workflow archive and distribute to TestFlight?');
      await sleep(30);
    }
  }
  for (;;) {
    const b = (await api('GET', `/v1/builds/${build.id}`)).data.attributes;
    const beta = (await api('GET', `/v1/builds/${build.id}/buildBetaDetail`)).data.attributes;
    say(`build ${b.version}: ${b.processingState.toLowerCase()}, internal testing ${beta.internalBuildState.toLowerCase()}`);
    if (b.processingState === 'INVALID' || b.processingState === 'FAILED') throw new Error(`build ${b.version} ${b.processingState}: App Store Connect turned it down.`);
    if (beta.internalBuildState === 'MISSING_EXPORT_COMPLIANCE') throw new Error(`build ${b.version} waits on its export compliance answer (ITSAppUsesNonExemptEncryption in Config/Info.plist).`);
    if (beta.internalBuildState === 'IN_BETA_TESTING') {
      console.log(`build ${b.version} is in TestFlight: open TestFlight on the iPhone to install it.`);
      return;
    }
    await sleep(30);
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  check: () => check(),
  group: () => group(rest[0]),
  ship: () => ship(rest.find((a) => !a.startsWith('--')), rest.includes('--wait')),
  wait: () => until(rest[0]),
};
if (!commands[command]) {
  console.error('Usage: node scripts/testflight.mjs check | group <email> | ship [branch] [--wait] | wait <run id>');
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
