'use strict'

const path = require('path')
const { once } = require('events')
const { realpathSync, symlinkSync } = require('fs')
const { Worker } = require('worker_threads')
const spawk = require('spawk')
const t = require('tap')

const actualPromiseSpawn = require('../lib/index.js')
const actualPlatform = process.platform

// Keep ordinary spawn assertions stable across platforms; shell resolution
// behaviour has dedicated tests below.
const promiseSpawn = t.mock('../lib/index.js', {
  which: { sync: (cmd) => path.win32.basename(cmd) },
})

spawk.preventUnmatched()
t.afterEach(() => {
  spawk.clean()
})

const mockPlatform = (t, platform) => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...platformDesc, value: platform })
  t.teardown(() => {
    Object.defineProperty(process, 'platform', platformDesc)
  })
}

const mockEnv = (t, key, value) => {
  const original = process.env[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
  t.teardown(() => {
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  })
}

const mockCwd = (t, cwd) => {
  const original = process.cwd
  process.cwd = () => cwd
  t.teardown(() => {
    process.cwd = original
  })
}

t.test('sh', (t) => {
  t.test('runs in shell', async (t) => {
    mockPlatform(t, 'win32')
    const proc = spawk.spawn('sh', ['-c', 'echo hello'], { shell: false })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('echo', ['hello'], { shell: 'sh' })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('escapes arguments', async (t) => {
    const proc = spawk.spawn('sh', ['-c', 'echo \'hello world\''], { shell: false })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('echo', ['hello world'], { shell: 'sh' })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.end()
})

t.test('shell interpreter resolution', (t) => {
  t.test('preserves quotes in the ambient POSIX PATH and ignores the child PATH', async (t) => {
    mockPlatform(t, 'linux')
    mockEnv(t, 'PATH', '"":/usr/bin:/unused')
    const calls = []
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (candidate) => {
          calls.push(candidate)
          return candidate === '/usr/bin/sh' ? candidate : null
        },
      },
    })
    mockCwd(t, '/lookup')

    const proc = spawk.spawn('/usr/bin/sh', ['-c', 'echo hello'], { shell: false })
      .stdout(Buffer.from('hello\n'))

    await promiseSpawnMock('echo', ['hello'], {
      shell: 'sh',
      env: { PATH: '/tmp/evil/node_modules/.bin' },
    })

    t.same(calls, ['/lookup/""/sh', '/usr/bin/sh'])
    t.ok(proc.called, 'spawned the resolved absolute shell path')
  })

  t.test('anchors relative and empty POSIX PATH entries to the lookup cwd', async (t) => {
    mockPlatform(t, 'linux')
    mockEnv(t, 'PATH', 'tools::/unused')

    const calls = []
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (candidate) => {
          calls.push(candidate)
          return candidate === '/lookup/sh' ? candidate : null
        },
      },
    })
    mockCwd(t, '/lookup')
    const env = { PATH: '/execution/evil' }
    const proc = spawk.spawn('/lookup/sh', ['-c', 'echo hello'], {
      cwd: '/execution',
      env,
      shell: false,
    })
      .stdout(Buffer.from('hello\n'))

    await promiseSpawnMock('echo', ['hello'], {
      cwd: '/execution',
      env,
      shell: 'sh',
    })

    t.same(calls, ['/lookup/tools/sh', '/lookup/sh'])
    t.ok(proc.called)
  })

  t.test('traverses POSIX parent components on the filesystem', {
    skip: actualPlatform === 'win32',
  }, async (t) => {
    const root = realpathSync.native(t.testdir({ file: '', physical: { child: {} } }))
    symlinkSync('physical/child', path.join(root, 'alias..name'))
    const relative = path.relative(process.cwd(), root)
    const promiseSpawnMock = t.mock('../lib/index.js', { which: { sync: candidate => candidate } })
    for (const [searchPath, directory] of [
      [`${relative}/missing/..:${root}/file/..:${relative}/alias..name/..`, 'physical'],
      [`${relative}/alias..name`, 'alias..name'],
    ]) {
      await t.test(`uses the ${directory} directory`, async (t) => {
        mockEnv(t, 'PATH', searchPath)
        const proc = spawk.spawn(path.join(root, directory, 'runner'), ['-c', 'echo'])
        await promiseSpawnMock('echo', [], { shell: 'runner', cwd: root })
        t.ok(proc.called)
      })
    }
  })

  t.test('reports unexpected filesystem errors during POSIX shell lookup', async (t) => {
    mockPlatform(t, 'linux')
    mockEnv(t, 'PATH', 'inaccessible/..:unreadable/..:/next')
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const ioError = Object.assign(new Error('I/O error'), { code: 'EIO' })
    const native = dir => {
      throw dir === 'inaccessible/..' ? denied : ioError
    }
    const promiseSpawnMock = t.mock('../lib/index.js', {
      fs: { realpathSync: { native } },
      which: { sync: () => t.fail('unexpected executable lookup') },
    })
    const p = promiseSpawnMock('echo', [], { shell: 'runner' })
    let emitted
    p.process.once('error', er => {
      emitted = er
    })
    const error = await p.catch(er => er)
    t.equal(error, ioError)
    t.equal(emitted, ioError)
    t.match(error, { code: 'EIO', cmd: 'echo', args: [] })
  })

  t.test('reads a worker environment containing only Path', async (t) => {
    const windows = actualPlatform === 'win32'
    const directory = windows ? path.join(process.env.SystemRoot, 'System32') : '/bin'
    const shell = windows ? 'cmd.exe' : 'sh'
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      require(workerData.module)('echo', ['ok'], { shell: workerData.shell }).then(
        ({ cmd }) => parentPort.postMessage(cmd),
        error => parentPort.postMessage(error.code)
      )
    `, {
      eval: true,
      env: { Path: directory },
      workerData: { module: require.resolve('../lib/index.js'), shell },
    })
    const [result] = await once(worker, 'message')
    t.equal(result, windows ? path.join(directory, shell) : 'ENOENT')
  })

  for (const platform of ['linux', 'win32']) {
    for (const [state, value] of [['unset', undefined], ['empty', '']]) {
      t.test(`skips bare shell lookup with ${state} PATH on ${platform}`, async (t) => {
        mockPlatform(t, platform)
        mockEnv(t, 'PATH', value)
        const promiseSpawnMock = t.mock('../lib/index.js', {
          which: { sync: () => t.fail('unexpected shell lookup') },
        })

        await t.rejects(promiseSpawnMock('echo', [], {
          shell: 'missing-shell',
          env: { PATH: 'child-bin' },
        }), { code: 'ENOENT' })
      })
    }
  }

  t.test('rejects when a bare shell is not on the trusted PATH', async (t) => {
    mockPlatform(t, 'linux')
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: () => null,
      },
    })

    const promise = promiseSpawnMock('echo', ['hello'], {
      shell: 'missing-shell',
      stdioString: false,
    }, {
      extra: 'property',
    })
    let emittedError
    const events = []
    promise.process.on('error', er => {
      emittedError = er
      events.push(['error'])
    })
    for (const event of ['spawn', 'exit', 'close']) {
      promise.process.on(event, (code, signal) => events.push([event, code, signal]))
    }

    const rejection = promise.catch(er => er)
    t.equal(promise.process.unref(), undefined)
    t.equal(promise.process.ref(), undefined)
    t.equal(promise.process.kill(), false)
    const error = await rejection
    t.match(error, {
      code: 'ENOENT',
      message: 'not found: missing-shell',
      cmd: 'echo',
      args: ['hello'],
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      extra: 'property',
    })
    await new Promise(resolve => setImmediate(resolve))
    t.equal(emittedError, error)
    t.same(events, [['error'], ['exit', null, null], ['close', null, null]])
  })

  t.test('closes failed shell pipes before the process closes', async (t) => {
    mockEnv(t, 'PATH', '')
    const p = actualPromiseSpawn('echo', [], { shell: 'missing-shell' })
    const rejection = t.rejects(p, { code: 'ENOENT', stdout: '', stderr: '' })
    const proc = p.process
    const closed = []
    const chunks = []
    t.equal(p.stdin, proc.stdin)
    for (const [fd, stream] of [proc.stdin, proc.stdout, proc.stderr].entries()) {
      t.equal(proc.stdio[fd], stream)
      stream.on('close', () => closed.push(fd))
    }
    proc.on('close', () => closed.push('process'))
    proc.stdout.on('data', chunk => chunks.push(chunk))
    p.stdin.end('input')

    await rejection
    await new Promise(resolve => setImmediate(resolve))
    t.equal(closed.pop(), 'process')
    t.same(closed.sort(), [0, 1, 2])
    t.same(chunks, [])
    t.ok(proc.stdin.destroyed)
    t.ok(proc.stdout.readableEnded)
    t.ok(proc.stderr.readableEnded, 'unread stderr also reached EOF')
  })

  t.test('destroys failed stdin before deferred input', async (t) => {
    mockEnv(t, 'PATH', '')
    const p = actualPromiseSpawn('echo', [], { shell: 'missing-shell' })
    const rejection = t.rejects(p, { code: 'ENOENT' })
    const errors = []
    let writeError
    p.stdin.on('error', er => errors.push(er))
    p.process.once('error', () => t.ok(p.stdin.destroyed, 'destroyed before notifying listeners'))
    process.nextTick(() => p.stdin.end('input', er => {
      writeError = er
    }))

    await rejection
    await new Promise(resolve => setImmediate(resolve))
    t.match(writeError, { code: 'ERR_STREAM_DESTROYED' })
    t.same(errors, [])
  })

  t.test('creates only the requested standard pipes on lookup failure', async (t) => {
    mockEnv(t, 'PATH', '')
    for (const [stdio, expected] of [
      ['inherit', [null, null, null]],
      ['overlapped', [true, true, true]],
      [[null, 'ignore', process.stderr], [true, null, null]],
      [[0, 'overlapped'], [null, true, true]],
    ]) {
      const p = actualPromiseSpawn('echo', [], { shell: 'missing-shell', stdio })
      let closes = 0
      p.process.on('close', () => closes++)
      await t.rejects(p, { code: 'ENOENT' })
      await new Promise(resolve => setImmediate(resolve))
      t.equal(closes, 1)
      t.same(p.process.stdio.map(stream => stream && stream.closed), expected)
    }
  })

  t.test('preserves an explicit POSIX shell path without PATH', async (t) => {
    mockPlatform(t, 'linux')
    mockEnv(t, 'PATH', undefined)
    const shell = './tools/cmd'
    const calls = []
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key) => {
          calls.push(key)
          return key
        },
      },
    })

    const proc = spawk.spawn(shell, ['-c', 'echo hello'], {
      cwd: '/tmp/project',
      shell: false,
    })
      .stdout(Buffer.from('hello\n'))

    await promiseSpawnMock('echo', ['hello'], {
      cwd: '/tmp/project',
      shell,
    })

    t.same(calls, [], 'did not resolve an explicit shell path')
    t.ok(proc.called, 'passed the explicit path through to spawn')
  })

  t.end()
})

t.test('Windows shell interpreter resolution', (t) => {
  t.test('checks only path-qualified ambient PATH candidates', async (t) => {
    mockPlatform(t, 'win32')
    mockEnv(t, 'PATH', [
      'C:\\first', '', '""', "''", "'C:\\single;quoted'", '"C:\\Program Files;shared"',
      "C:\\tools'", `"C:\\quoted'"`, 'C:\\plain', '"C:\\last;entry',
    ].join(';'))
    mockEnv(t, 'PATHEXT', '.EXE;.CMD')

    const shellCalls = []
    const trustedShell = 'C:\\last;entry\\cmd.exe'
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key, opts) => {
          if (key === 'echo') {
            return 'echo.exe'
          }
          shellCalls.push({ key, opts })
          return key === trustedShell ? key : null
        },
      },
    })

    const proc = spawk.spawn(trustedShell, ['/d', '/s', '/c', 'echo hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    await promiseSpawnMock('echo', ['hello'], {
      shell: 'cmd.exe',
      env: { PATH: 'C:\\evil' },
    })

    t.same(shellCalls.map(({ key }) => key), [
      'C:\\first\\cmd.exe',
      'C:\\single;quoted\\cmd.exe',
      'C:\\Program Files;shared\\cmd.exe',
      "C:\\tools'\\cmd.exe",
      "C:\\quoted'\\cmd.exe",
      'C:\\plain\\cmd.exe',
      trustedShell,
    ])
    for (const { opts } of shellCalls) {
      t.equal(opts.pathExt, '.COM;.EXE')
      t.equal(opts.nothrow, true)
      t.notOk(opts.path, 'did not perform a bare PATH search')
    }
    t.ok(proc.called)
  })

  t.test('rejects when no Windows PATH candidate exists', async (t) => {
    mockPlatform(t, 'win32')
    mockEnv(t, 'PATH', 'C:\\first;C:\\last')

    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: () => null,
      },
    })

    await t.rejects(promiseSpawnMock('echo', ['hello'], { shell: 'missing.exe' }), {
      code: 'ENOENT',
      message: 'not found: missing.exe',
    })
  })

  t.test('preserves an explicit Windows shell path', async (t) => {
    mockPlatform(t, 'win32')
    mockEnv(t, 'PATH', undefined)
    const calls = []
    const shell = '.\\tools\\cmd.exe'
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key) => {
          calls.push(key)
          return 'echo.exe'
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'echo hello'], {
      cwd: 'C:\\project',
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    await promiseSpawnMock('echo', ['hello'], {
      cwd: 'C:\\project',
      shell,
    })

    t.same(calls, ['echo'], 'only resolved the command run inside cmd')
    t.ok(proc.called, 'passed the explicit shell path through to spawn')
  })

  t.test('does not select a shell from the current directory', {
    skip: actualPlatform !== 'win32',
  }, async (t) => {
    const fixture = t.testdir({
      cwd: { 'cmd.exe': '' },
      trusted: { 'cmd.exe': '' },
    })
    const originalCwd = process.cwd()
    const cwd = path.join(fixture, 'cwd')
    const trusted = path.join(fixture, 'trusted')
    const trustedShell = path.join(trusted, 'cmd.exe')

    mockEnv(t, 'PATH', trusted)
    mockEnv(t, 'PATHEXT', '.EXE')
    mockEnv(t, 'NoDefaultCurrentDirectoryInExePath', '1')
    t.teardown(() => process.chdir(originalCwd))
    process.chdir(cwd)

    const proc = spawk.spawn(trustedShell, ['/d', '/s', '/c', 'echo hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    await actualPromiseSpawn('echo', ['hello'], { shell: 'cmd.exe' })
    t.ok(proc.called, 'spawned the shell from the trusted PATH')
  })

  t.test('skips batch files and prefers .COM to .EXE for bare shells', {
    skip: actualPlatform !== 'win32',
  }, async (t) => {
    const fixture = t.testdir({
      "first'": { 'runner.CMD': '', 'both.COM': '', 'both.EXE': '' },
      'second;tools': { 'runner.EXE': '' },
    })
    const first = path.join(fixture, "first'")
    const second = path.join(fixture, 'second;tools')
    mockEnv(t, 'PATH', [first, `"${second}"`].join(path.delimiter))
    mockEnv(t, 'PATHEXT', '.CMD;.EXE;.COM')

    for (const [shell, file] of [
      ['runner', path.join(second, 'runner.EXE')], ['both', path.join(first, 'both.COM')],
    ]) {
      const proc = spawk.spawn(file, ['-c', 'echo hello'])
      await actualPromiseSpawn('echo', ['hello'], { shell })
      t.ok(proc.called)
    }
  })

  t.end()
})

t.test('cmd', (t) => {
  mockPlatform(t, 'win32')

  for (const shell of ['cmd', 'cmd.exe']) {
    t.test(`keeps cmd syntax when ${shell} resolves to a POSIX path`, async (t) => {
      mockPlatform(t, 'linux')
      const directory = '/mnt/c/Windows/System32'
      mockEnv(t, 'PATH', directory)
      const resolved = `${directory}/${shell}`
      const promiseSpawnMock = t.mock('../lib/index.js', {
        which: { sync: key => key === 'echo' ? 'echo.exe' : key },
      })
      const proc = spawk.spawn(resolved, ['/d', '/s', '/c', 'echo ^"two^ words^"'], {
        shell: false,
        windowsVerbatimArguments: true,
      })

      await promiseSpawnMock('echo', ['two words'], { shell })
      t.ok(proc.called)
    })
  }

  const shell = 'C:\\Windows\\System32\\cmd.exe'

  t.test('runs in shell', async (t) => {
    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'echo hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('echo', ['hello'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('falls back to the bare initial cmd when it cannot be resolved', async (t) => {
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: () => {
          throw new Error('not found')
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'nope hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawnMock('nope', ['hello'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('works when initial cmd is wrapped in quotes', async (t) => {
    const proc = spawk.spawn(shell, ['/d', '/s', '/c', '"echo" hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('"echo"', ['hello'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('works when initial cmd has a space and is wrapped in quotes', async (t) => {
    const proc = spawk.spawn(shell, ['/d', '/s', '/c', '"two words" hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('"two words"', ['hello'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  for (const testCase of [
    {
      name: 'works when initial cmd is escaped and wrapped in quotes',
      command: '^"echo^"',
      lookup: 'echo',
      resolved: 'echo.exe',
      script: '^"echo^" hello',
      args: ['hello'],
      stdout: 'hello',
    },
    {
      name: 'finds an escaped batch shim for double escaping',
      command: '^"shim.cmd^"',
      lookup: 'shim.cmd',
      resolved: 'shim.cmd',
      script: '^"shim.cmd^" ^^^"hello^^^ world^^^"',
      args: ['hello world'],
      stdout: 'hello world',
    },
    {
      name: 'finds an escaped batch shim with a space',
      command: '^"two^ words.cmd^"',
      lookup: 'two words.cmd',
      resolved: 'two words.cmd',
      script: '^"two^ words.cmd^" ^^^"hello^^^ world^^^"',
      args: ['hello world'],
      stdout: 'hello world',
    },
  ]) {
    t.test(testCase.name, async (t) => {
      const promiseSpawnMock = t.mock('../lib/index.js', {
        which: {
          sync: (key) => {
            t.equal(key, testCase.lookup)
            return testCase.resolved
          },
        },
      })

      const proc = spawk.spawn(shell, ['/d', '/s', '/c', testCase.script], {
        shell: false,
        windowsVerbatimArguments: true,
      })
        .stdout(Buffer.from(`${testCase.stdout}\n`))

      const result = await promiseSpawnMock(testCase.command, testCase.args, { shell })
      t.hasStrict(result, {
        code: 0,
        signal: undefined,
        stdout: testCase.stdout,
        stderr: '',
      })

      t.ok(proc.called)
    })
  }

  t.test('works when initial cmd is more than one command', async (t) => {
    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'one two three hello'], {
      shell: false,
      windowsVerbatimArguments: true,
    })
      .stdout(Buffer.from('hello\n'))

    const result = await promiseSpawn('one two three', ['hello'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: 'hello',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('escapes when cmd is a .exe', async (t) => {
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key) => {
          t.equal(key, 'dir')
          return 'dir.exe'
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'dir ^"with^ spaces^"'], {
      shell: false,
      windowsVerbatimArguments: true,
    })

    const result = await promiseSpawnMock('dir', ['with spaces'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: '',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('double escapes when cmd is a .cmd', async (t) => {
    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key) => {
          t.equal(key, 'dir')
          return 'dir.cmd'
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'dir ^^^"with^^^ spaces^^^"'], {
      shell: false,
      windowsVerbatimArguments: true,
    })

    const result = await promiseSpawnMock('dir', ['with spaces'], { shell })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: '',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('which respects provided env PATH/PATHEXT', async (t) => {
    const PATH = 'C:\\Windows\\System32'
    const PATHEXT = 'EXE'

    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key, opts) => {
          t.equal(key, 'dir')
          t.equal(opts.path, PATH)
          t.equal(opts.pathExt, PATHEXT)
          return 'dir.exe'
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'dir ^"with^ spaces^"'], {
      shell: false,
      windowsVerbatimArguments: true,
    })

    const result = await promiseSpawnMock('dir', ['with spaces'], {
      env: {
        PATH,
        PATHEXT,
      },
      shell,
    })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: '',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.test('which respects variant casing for provided env PATH/PATHEXT', async (t) => {
    const PATH = 'C:\\Windows\\System32'
    const PATHEXT = 'EXE'

    const promiseSpawnMock = t.mock('../lib/index.js', {
      which: {
        sync: (key, opts) => {
          t.equal(key, 'dir')
          t.equal(opts.path, PATH)
          t.equal(opts.pathExt, PATHEXT)
          return 'dir.exe'
        },
      },
    })

    const proc = spawk.spawn(shell, ['/d', '/s', '/c', 'dir ^"with^ spaces^"'], {
      shell: false,
      windowsVerbatimArguments: true,
    })

    const result = await promiseSpawnMock('dir', ['with spaces'], {
      env: {
        pAtH: PATH,
        pathEXT: PATHEXT,
      },
      shell,
    })
    t.hasStrict(result, {
      code: 0,
      signal: undefined,
      stdout: '',
      stderr: '',
    })

    t.ok(proc.called)
  })

  t.end()
})
