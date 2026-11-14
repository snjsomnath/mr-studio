// Layer dev mode: runs the host and the web dev server together.
//   pnpm dev                      sample site
//   pnpm dev -- --site sites/x    another site
//   pnpm dev -- --lan             also reachable from phones on this network (QR code on /tv and /dev)
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const extra = process.argv.slice(2).filter((arg) => arg !== '--');
const web = [];
if (extra.includes('--lan')) {
  // Phones load the pages from the web dev server, so that is the address the QR code must carry.
  const addresses = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  if (addresses.length > 0 && !extra.includes('--public-url')) extra.push('--public-url', `http://${addresses[0].address}:5173`);
  web.push('--host');
}
const children = [
  spawn('cargo', ['run', '-p', 'mrs-cli', '--', 'dev', ...extra], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@mrstudio/runtime', 'dev', ...web], { stdio: 'inherit' }),
];
const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((child) => child.on('exit', stop));
console.log('\nOpen http://localhost:5173/dev (table and controls), /table, /tv or /phone?c=<session code>\n');
