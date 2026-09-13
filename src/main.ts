import { APP_VERSION } from './version.js';

const HELP = `QuotaHot - quota scheduling web service

Usage:
  quotahot [serve]
  quotahot version
  quotahot --help
  quotahot --version
`;

export async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === 'version' || command === '--version') {
    console.log(APP_VERSION);
    return 0;
  }
  if (command === undefined || command === 'serve') {
    if (argv.length > 1) {
      console.error(`Unknown argument: ${argv[1]}`);
      return 2;
    }
    await import('./server/main.js');
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
    return 0;
  }
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  return 2;
}

void run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
