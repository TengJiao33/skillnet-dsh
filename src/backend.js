import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const protocolLimit = 24 * 1024 * 1024;
const sendLine = (handle, value) => new Promise((resolve, reject) => {
  handle.stdin.write(JSON.stringify(value) + '\n', 'utf8', error => error ? reject(error) : resolve());
});

export function pythonExecutable(config = {}) {
  const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return config.python || process.env.DSH_SKILLNET_PYTHON || (existsSync(local) ? local : 'python');
}

// Every read still scans the current files and index.
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
        if (!state.pending || Buffer.byteLength(line) > protocolLimit) throw new Error('SkillNet 技能库通信数据无效或超过大小限制。');
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

// A single warm slot avoids Python imports for sequential conversation routes.
// Concurrent conversations fall through to their own processes instead of
// sharing a host bridge or waiting behind another conversation's model call.
function createRouteWorker(subprocess, config) {
  let worker, current;
  async function launch(signal) {
    const executable = await subprocess.resolveExecutable(pythonExecutable(config));
    signal.throwIfAborted();
    const processAbort = new AbortController();
    const handle = subprocess.spawn({
      argv: [executable, join(root, 'python/worker.py'), '--route-service'], cwd: root,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16 * 1024 } },
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, graceMs: 500, signal: processAbort.signal,
    });
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity });
    const state = { handle, active: null, stopping: null, stop(reason) {
      if (state.stopping) return state.stopping;
      state.stopping = Promise.allSettled([
        Promise.resolve().then(() => handle.terminate()),
        Promise.resolve().then(() => handle.waitForExit()),
      ]).then(() => {
        lines.close();
        if (worker === state) worker = null;
      });
      state.active?.fail(reason);
      processAbort.abort(reason);
      return state.stopping;
    } };
    lines.on('line', line => {
      try {
        if (!state.active || Buffer.byteLength(line) > protocolLimit) throw new Error('SkillNet 路由通信数据无效或超过大小限制。');
        state.active.consume(JSON.parse(line));
      } catch (error) { void state.stop(error); }
    });
    lines.on('error', error => { void state.stop(error); });
    lines.on('close', () => { void state.stop(new Error('SkillNet 路由通信通道已关闭。')); });
    handle.stdin.on('error', error => { void state.stop(error); });
    handle.done.then(() => state.stop(new Error('SkillNet 路由进程已退出，请重试。')), error => state.stop(error));
    worker = state;
    return state;
  }
  async function route(request, signal, rpcAbort, invokeHost) {
    await worker?.stopping;
    signal.throwIfAborted();
    const state = worker || await launch(signal);
    const result = Promise.withResolvers();
    let hostCall, replyStarted = false, finalReceived = false;
    state.active = {
      fail(reason) { result.reject(reason); rpcAbort.abort(reason); },
      consume(value) {
        if (finalReceived) throw new Error('SkillNet 路由进程返回了多余的数据。');
        if (value?.type === 'host-call') {
          if (hostCall || value.method !== 'explore' || typeof value.id !== 'string' ||
              typeof value.system !== 'string' || typeof value.prompt !== 'string') {
            throw new Error('SkillNet 路由模型通信请求无效。');
          }
          hostCall = (async () => {
            let reply;
            try { reply = { ok: true, data: await invokeHost(value, signal) }; }
            catch (error) { signal.throwIfAborted(); reply = { ok: false, error: error.message }; }
            signal.throwIfAborted();
            replyStarted = true;
            await sendLine(state.handle, { id: value.id, ...reply });
          })();
          void hostCall.catch(error => { void state.stop(error); });
        } else {
          if (typeof value?.ok !== 'boolean' || hostCall && !replyStarted) throw new Error('SkillNet 路由进程返回了无效结果。');
          finalReceived = true;
          result.resolve(value);
        }
      },
    };
    const cancel = () => { void state.stop(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    let value;
    try {
      const sent = signal.aborted ? cancel() : sendLine(state.handle, request);
      [value] = await Promise.all([result.promise, sent]);
      await hostCall;
      signal.throwIfAborted();
    } catch (error) {
      await state.stop(error);
      if (hostCall) await Promise.allSettled([hostCall]);
      signal.throwIfAborted();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      state.active = null;
    }
    if (!value.ok) throw new Error(value.error?.message || 'SkillNet 路由未完成。');
    return value.data;
  }
  return {
    tryRoute(request, signal, rpcAbort, invokeHost) {
      if (current) return null;
      current = route(request, signal, rpcAbort, invokeHost);
      const release = () => { current = null; };
      void current.then(release, release);
      return current;
    },
    async dispose(reason) {
      await worker?.stop(reason);
      await Promise.allSettled([current]);
    },
  };
}

export function createBackend(subprocess, config = {}) {
  const reader = createLibraryReader(subprocess, config);
  const routes = createRouteWorker(subprocess, config);
  const routeAbort = new AbortController();
  const activeRoutes = new Set();
  const execute = async (request, callerSignal, invokeHost, onProgress) => {
    const bridged = Boolean(request._host_model);
    const report = request.action === 'analyze' && typeof onProgress === 'function';
    const streamed = bridged || report;
    const rpcAbort = new AbortController();
    const signals = [rpcAbort.signal, ...(callerSignal ? [callerSignal] : [])];
    if (request.action === 'route') signals.push(routeAbort.signal);
    // A large background build is cancellable and has per-request timeouts.
    // A whole-build deadline would also abort healthy, progressing builds.
    if (request.action !== 'analyze' || !bridged) {
      const timeout = ['analyze', 'create', 'evaluate', 'review-sample'].includes(request.action) ? 3_600_000 : request.action === 'analysis-step' ? 600_000 : request.action === 'route' ? 720_000 : request.action === 'inspect' ? 180_000 : 30_000;
      signals.push(AbortSignal.timeout(timeout));
    }
    const signal = AbortSignal.any(signals);
    if (bridged && !invokeHost) throw new Error('DSH 模型通道尚未连接。');
    signal.throwIfAborted();
    if (request.action === 'local-library') return reader.read(request, signal);
    if (request.action === 'route' && bridged) {
      const warm = routes.tryRoute(request, signal, rpcAbort, invokeHost);
      if (warm) return warm;
    }
    const executable = await subprocess.resolveExecutable(pythonExecutable(config));
    signal.throwIfAborted();
    const handle = subprocess.spawn({
      argv: [executable, join(root, 'python/worker.py')],
      cwd: root,
      stdio: {
        stdin: streamed ? 'pipe' : { data: JSON.stringify(request) + '\n' },
        stdout: streamed ? 'pipe' : { maxBytes: 24 * 1024 * 1024 },
        stderr: { maxBytes: 16 * 1024 },
      },
      env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      graceMs: 500,
      signal,
    });
    const pending = new Map();
    try {
      if (streamed) {
        let result, activeModels = 0;
        const modelLimit = request.action === 'analyze' && request.max_workers === 4 ? 4 : 2;
        handle.stdin.on('error', () => rpcAbort.abort(new Error('模型通信进程已退出。')));
        const send = value => sendLine(handle, value);
        await send(report ? { ...request, _progress: true } : request);
        const completion = handle.done.then(() => { if (activeModels) rpcAbort.abort(new Error('SkillNet 后端提前退出。')); });
        const respond = async call => {
          let reply;
          activeModels++;
          try { reply = { ok: true, data: await invokeHost(call, signal) }; }
          catch (error) {
            signal.throwIfAborted();
            reply = { ok: false, error: error.message };
          } finally { activeModels--; }
          signal.throwIfAborted();
          await send({ id: call.id, ...reply });
        };
        const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity });
        const read = (async () => {
          for await (const line of lines) {
            if (Buffer.byteLength(line) > protocolLimit) throw new Error('模型通信数据超过大小限制。');
            const value = JSON.parse(line);
            if (report && value.type === 'relation-progress' && Number.isSafeInteger(value.remaining) && value.remaining > 0) {
              onProgress(`正在复核剩余 ${value.remaining} 对候选`);
            } else if (bridged && value.type === 'host-call') {
              if (typeof value.id !== 'string' || pending.has(value.id) || !['chat', 'explore'].includes(value.method) ||
                  typeof value.system !== 'string' || typeof value.prompt !== 'string' || activeModels >= modelLimit) {
                throw new Error('模型通信请求无效或超过并发上限。');
              }
              const work = respond(value);
              pending.set(value.id, work);
              void work.then(() => pending.delete(value.id), error => {
                pending.delete(value.id);
                rpcAbort.abort(error);
              });
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
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      rpcAbort.abort(new Error('SkillNet 操作已结束。'));
      try {
        await handle.terminate();
        await handle.waitForExit();
      } finally { await Promise.allSettled(pending.values()); }
    }
  };
  const run = (request, ...args) => {
    const work = execute(request, ...args);
    if (request.action === 'route') {
      activeRoutes.add(work);
      void work.then(() => activeRoutes.delete(work), () => activeRoutes.delete(work));
    }
    return work;
  };
  run.dispose = async () => {
    const reason = new Error('SkillNet 插件已停止。');
    routeAbort.abort(reason);
    await Promise.all([reader.dispose(), routes.dispose(reason), Promise.allSettled(activeRoutes)]);
  };
  return run;
}
