// Layer dev mode: runs the host and the web dev server together.
//   pnpm dev                      sample site
//   pnpm dev -- --site sites/x    another site
import { spawn } from 'node:child_process';

const extra = process.argv.slice(2).filter((arg) => arg !== '--');
const children = [
  spawn('cargo', ['run', '-p', 'mrs-cli', '--', 'dev', ...extra], { stdio: 'inherit' }),
  spawn('pnpm', ['--filter', '@mrstudio/runtime', 'dev'], { stdio: 'inherit' }),
];
const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
children.forEach((child) => child.on('exit', stop));
console.log('\nOpen http://localhost:5173/dev (table and controls), /table, /tv or /phone?c=<session code>\n');
