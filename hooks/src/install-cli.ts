import {
  installOpencode, installOmo, omoExtensionPath, omoPlugin, opencodePlugin,
  opencodePluginPath, selfInvocation, uninstallCodex, uninstallOpencode, uninstallOmo, uninstallPi,
} from './install.js';
import { UsageError } from './cli-types.js';

export async function install(
  targets: readonly string[],
  options: { readonly remove: boolean; readonly print: boolean },
): Promise<number> {
  if (targets.length > 1 || (targets.length === 1 && targets[0] !== 'omo')) {
    throw new UsageError(`Unexpected target: ${targets[0]}`);
  }
  if (targets[0] === 'omo') {
    if (options.print) {
      console.log(`# ${omoExtensionPath()}\n${omoPlugin(selfInvocation())}`);
      return 0;
    }
    const report = options.remove ? await uninstallOmo() : await installOmo(selfInvocation());
    for (const change of report.changes) console.log(change);
    return 0;
  }
  if (options.print) {
    console.log(`# ${await opencodePluginPath()}\n${opencodePlugin([...selfInvocation(), 'run', 'opencode'])}`);
    return 0;
  }
  const reports = options.remove
    ? await Promise.all([uninstallOpencode(), uninstallCodex(), uninstallPi()])
    : [await installOpencode([...selfInvocation(), 'run', 'opencode']), await uninstallCodex(), await uninstallPi()];
  for (const report of reports) for (const change of report.changes) console.log(change);
  return 0;
}
