import { mkdir as mkdirOmoStatus, rename as renameOmoStatus, unlink as unlinkOmoStatus, writeFile as writeOmoStatus } from 'node:fs/promises';

function createOmoRecoveryStatus(groups, dataDir) {
  const id = randomUUID();
  const directory = omoJoin(dataDir, 'recovery-status');
  const path = omoJoin(directory, id + '.json');
  let heartbeat;
  let writes = Promise.resolve();

  function publish() {
    const active = [...groups.values()].filter((group) => group.entries.size);
    const sessions = active.flatMap((group) => [...group.entries]
      .filter((entry) => entry.active()).map((entry) => ({
        sessionID: entry.sessionID.slice(0, 128),
        phase: group.ready ? 'ready' : group.running ? 'checking' : 'waiting',
      })));
    const deadlines = active.map((group) => group.nextCheckAt).filter(Number.isFinite);
    const latest = active.filter((group) => group.lastCheckedAt !== null)
      .sort((left, right) => right.lastCheckedAt - left.lastCheckedAt)[0];
    const snapshot = sessions.length ? JSON.stringify({
      version: 1, source: 'omo', id, pid: process.pid, updatedAt: Date.now(),
      phase: sessions.some((entry) => entry.phase === 'checking') ? 'checking'
        : sessions.some((entry) => entry.phase === 'waiting') ? 'waiting' : 'ready',
      waitingCount: sessions.length, sessions,
      nextCheckAt: deadlines.length ? Math.min(...deadlines) : null,
      lastCheckedAt: latest?.lastCheckedAt ?? null, lastOutcome: latest?.lastOutcome ?? null,
    }) : null;
    if (snapshot && !heartbeat) {
      heartbeat = setTimeout(() => { heartbeat = undefined; publish(); }, 60_000);
      heartbeat.unref?.();
    } else if (!snapshot) {
      clearTimeout(heartbeat);
      heartbeat = undefined;
    }
    writes = writes.then(async () => {
      if (snapshot === null) {
        await unlinkOmoStatus(path).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
        return;
      }
      await mkdirOmoStatus(directory, { recursive: true, mode: 0o700 });
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await writeOmoStatus(temporary, snapshot, { mode: 0o600 });
        await renameOmoStatus(temporary, path);
      } finally {
        await unlinkOmoStatus(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      }
    }).catch((error) => { console.error('QuotaHot: 无法发布 OmO 恢复状态', error); });
  }
  return publish;
}
