#!/usr/bin/env node
// An agent that exits the moment a paste reaches it, before the Enter that would send it: the
// rest of what ah types meets the shell it leaves behind.
process.stdin.setRawMode(true);
process.stdout.write('\x1b[?2004h> ');
process.stdin.on('data', (d) => {
  if (d.toString().includes('\x1b[200~')) {
    process.stdout.write('\x1b[?2004l');
    process.exit(0);
  }
});
