import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));

export function pythonExecutable(config = {}) {
  const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return config.python || process.env.DSH_SKILLNET_PYTHON || (existsSync(local) ? local : 'python');
}

// Keep only the SDK's read-only library reader warm. Every request still scans
// the current files and index; model jobs retain their own isolated processes.
function createLibraryReader(subprocess, config) {
  let worker, queue = Promise.resolve(), disposed = false;
  async function launch(signal) {
    const executable = await subprocess.resolveExecutable(pythonExecutable(config));
    signal.throwIfAborted();
    if (disposed) throw new Error('SkillNet 插件已停止。');
    const abort = new AbortController();
    const handle = subprocess.spawn({
      argv: [executable, join(root, 'python/worker.py'), '--library-reader'], cwd: root,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 } },
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, graceMs: 500, signal: abort.signal,
    });
    const state = { handle, lines: createInterface({ input: handle.stdout, crlfDelay: Infinity }), pending: null, stopping: null };
    state.stop = reason => {
      if (state.stopping) return state.stopping;
      if (worker === state) worker = null;
      const pending = state.pending; state.pending = null;
      pending?.(reason);
      abort.abort(reason);
      state.stopping = Promise.allSettled([
        Promise.resolve().then(() => handle.terminate()),
        Promise.resolve().then(() => handle.waitForExit()),
      ]).then(() => state.lines.close());
      return state.stopping;
    };
    state.lines.on('line', line => {
      try {
        if (!state.pending || Buffer.byteLength(line) > 24 * 1024 * 1024) throw new Error('SkillNet 技能库通信数据无效或超过大小限制。');
        const value = JSON.parse(line);
        const pending = state.pending; state.pending = null;
        pending(null, value);
      } catch (error) { void state.stop(error); }
    });
    state.lines.on('error', error => { void state.stop(error); });
    handle.stdin.on('error', error => { void state.stop(error); });
    handle.done.then(() => state.stop(new Error('SkillNet 技能库读取进程已退出，请重试。')), error => state.stop(error));
    worker = state;
    return state;
  }
  function read(request, signal) {
    const next = queue.then(async () => {
      signal.throwIfAborted();
      if (disposed) throw new Error('SkillNet 插件已停止。');
      const state = worker || await launch(signal);
      let value;
      try {
        value = await new Promise((resolve, reject) => {
          const cancel = () => { void state.stop(signal.reason); };
          state.pending = (error, result) => {
            signal.removeEventListener('abort', cancel);
            if (error) reject(error); else resolve(result);
          };
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) { cancel(); return; }
          const input = { action: 'local-library', sourcePath: request.sourcePath, indexPath: request.indexPath };
          state.handle.stdin.write(JSON.stringify(input) + '\n', 'utf8', error => { if (error) void state.stop(error); });
        });
      } catch (error) { await state.stop(error); throw error; }
      signal.throwIfAborted();
      if (!value?.ok) throw new Error(value?.error?.message || '无法读取技能库。');
      return value.data;
    });
    queue = next.catch(() => {});
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      next.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  return { read, async dispose() { disposed = true; await worker?.stop(new Error('SkillNet 插件已停止。')); await queue; } };
}

export function createBackend(subprocess, config = {}) {
  const reader = createLibraryReader(subprocess, config);
  const run = async (request, callerSignal, invokeHost) => {
    const deadline = AbortSignal.timeout(['analyze', 'create', 'evaluate'].includes(request.action) ? 3_600_000 : request.action === 'analysis-step' ? 600_000 : request.action === 'route' ? 720_000 : request.action === 'inspect' ? 180_000 : 30_000);
    const rpcAbort = new AbortController();
    const signal = AbortSignal.any([deadline, rpcAbort.signal, ...(callerSignal ? [callerSignal] : [])]);
    const bridged = Boolean(request._host_model);
    if (bridged && !invokeHost) throw new Error('DSH 模型通道尚未连接。');
    signal.throwIfAborted();
    if (request.action === 'local-library') return reader.read(request, signal);
    const executable = await subprocess.resolveExecutable(pythonExecutable(config));
    const handle = subprocess.spawn({
      argv: [executable, join(root, 'python/worker.py')],
      cwd: root,
      stdio: {
        stdin: bridged ? 'pipe' : { data: JSON.stringify(request) + '\n' },
        stdout: bridged ? 'pipe' : { maxBytes: 24 * 1024 * 1024 },
        stderr: { maxBytes: 16 * 1024 },
      },
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      graceMs: 500,
      signal,
    });
    try {
      if (bridged) {
        let result, hostBusy = false;
        handle.stdin.on('error', () => rpcAbort.abort(new Error('模型通信进程已退出。')));
        const send = value => new Promise((resolve, reject) => handle.stdin.write(JSON.stringify(value) + '\n', 'utf8', error => error ? reject(error) : resolve()));
        await send(request);
        const completion = handle.done.then(() => { if (hostBusy) rpcAbort.abort(new Error('SkillNet 后端提前退出。')); });
        const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity });
        const read = (async () => {
          for await (const line of lines) {
            if (Buffer.byteLength(line) > 24 * 1024 * 1024) throw new Error('模型通信数据超过大小限制。');
            const value = JSON.parse(line);
            if (value.type === 'host-call') {
              if (!['chat', 'explore'].includes(value.method) || typeof value.system !== 'string' || typeof value.prompt !== 'string') throw new Error('模型通信请求无效。');
              hostBusy = true;
              try { await send({ ok: true, data: await invokeHost(value, signal) }); }
              catch (error) { if (signal.aborted) throw error; await send({ ok: false, error: error.message }); }
              finally { hostBusy = false; }
            } else { result = value; handle.stdin.end(); }
          }
        })();
        await Promise.all([read, completion]);
        signal.throwIfAborted();
        if (!result?.ok) throw new Error(result?.error?.message || 'SkillNet 模型作业未完成。');
        return result.data;
      }
      await handle.done;
      signal.throwIfAborted();
      const output = handle.collected.stdout.readFrom(0);
      if (output.lossy) throw new Error('SkillNet 返回内容超过预览大小限制。');
      let result;
      try {
        result = JSON.parse(output.text);
      } catch {
        throw new Error('无法启动 SkillNet 后端，请在所配置的 Python 环境中安装 requirements.txt 依赖。');
      }
      if (!result.ok) throw new Error(result.error?.message || 'SkillNet 操作失败。');
      return result.data;
    } finally {
      rpcAbort.abort(new Error('SkillNet 操作已结束。'));
      await handle.terminate();
      await handle.waitForExit();
    }
  };
  run.dispose = () => reader.dispose();
  return run;
}
