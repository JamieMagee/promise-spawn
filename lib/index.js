'use strict'

const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const os = require('os')
const path = require('path')
const { Readable, Writable } = require('stream')
const which = require('which')

const escape = require('./escape.js')

// 'extra' object is for decorating the error a bit more
const promiseSpawn = (cmd, args, opts = {}, extra = {}) => {
  if (opts.shell) {
    return spawnWithShell(cmd, args, opts, extra)
  }

  let resolve, reject
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  // Create error here so we have a more useful stack trace when rejecting
  const closeError = new Error('command failed')

  const stdout = []
  const stderr = []

  const getResult = (result) => ({
    cmd,
    args,
    ...result,
    ...stdioResult(stdout, stderr, opts),
    ...extra,
  })
  const rejectWithOpts = (er, erOpts) => {
    const resultError = getResult(erOpts)
    reject(Object.assign(er, resultError))
  }

  const proc = spawn(cmd, args, opts)
  promise.stdin = proc.stdin
  promise.process = proc

  proc.on('error', rejectWithOpts)

  if (proc.stdout) {
    proc.stdout.on('data', c => stdout.push(c))
    proc.stdout.on('error', rejectWithOpts)
  }

  if (proc.stderr) {
    proc.stderr.on('data', c => stderr.push(c))
    proc.stderr.on('error', rejectWithOpts)
  }

  proc.on('close', (code, signal) => {
    if (code || signal) {
      rejectWithOpts(closeError, { code, signal })
    } else {
      resolve(getResult({ code, signal }))
    }
  })

  return promise
}

const hasPath = (command) => process.platform === 'win32'
  ? /[\\/:]/.test(command)
  : command.includes('/')

function * windowsPathEntries (searchPath) {
  let start = 0
  while (start < searchPath.length) {
    let end = start
    const quote = searchPath[start]
    // libuv only treats semicolons as quoted when the entry starts with a quote.
    if (quote === '"' || quote === "'") {
      start++
      end = searchPath.indexOf(quote, start)
      if (end === -1) {
        end = searchPath.length
      }
    }
    while (end < searchPath.length && searchPath[end] !== ';') {
      end++
    }
    const directory = searchPath.slice(start, end).replace(/['"]$/, '')
    if (directory) {
      yield directory
    }
    start = end + 1
  }
}

const resolveShell = (command) => {
  if (hasPath(command)) {
    return command
  }

  const windows = process.platform === 'win32'
  const searchPath = windows ? findInObject(process.env, 'PATH') : process.env.PATH
  if (!searchPath) {
    return null
  }

  const dirs = windows ? windowsPathEntries(searchPath) : searchPath.split(path.posix.delimiter)
  const paths = windows ? path.win32 : path.posix
  const options = { nothrow: true, pathExt: windows ? '.COM;.EXE' : undefined }
  for (const dir of dirs) {
    const resolved = which.sync(paths.resolve(dir, command), options)
    if (resolved) {
      return resolved
    }
  }

  return null
}

const getNotFoundError = (command) =>
  Object.assign(new Error(`not found: ${command}`), { code: 'ENOENT' })

const rejectNotFound = (command, cmd, args, opts, extra) => {
  const stdio = [0, 1, 2].map(fd => {
    const type = stdioType(opts.stdio, fd)
    if (type !== 'pipe' && type !== 'overlapped') {
      return null
    }
    return fd === 0
      ? new Writable({ write: (chunk, encoding, cb) => cb() })
      : Readable.from([], { objectMode: false })
  })
  const [stdin, stdout, stderr] = stdio
  const proc = new EventEmitter()
  Object.assign(proc, { stdin, stdout, stderr, stdio, kill: () => false })
  const pipes = stdio.filter(Boolean)
  let pending = pipes.length + 1 // Wait for exit even when there are no pipes.
  const maybeClose = () => {
    if (--pending === 0) {
      process.nextTick(() => proc.emit('close', null, null))
    }
  }
  for (const pipe of pipes) {
    pipe.once('close', maybeClose)
  }

  const error = Object.assign(getNotFoundError(command), {
    cmd,
    args,
    ...stdioResult([], [], opts),
    ...extra,
  })
  const promise = new Promise((_, reject) => proc.once('error', reject))
  promise.stdin = stdin
  promise.process = proc

  process.nextTick(() => {
    proc.emit('error', error)
    // run-script removes its signal handlers on exit.
    proc.emit('exit', null, null)
    stdin?.end()
    stdout?.resume()
    stderr?.resume()
    maybeClose()
  })
  return promise
}

const spawnWithShell = (cmd, args, opts, extra) => {
  let command = opts.shell
  // if shell is set to true, we use a platform default. we can't let the core
  // spawn method decide this for us because we need to know what shell is in use
  // ahead of time so that we can escape arguments properly. we don't need coverage here.
  if (command === true) {
    // istanbul ignore next
    command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh'
  }

  // WSL can resolve cmd.exe to a POSIX path.
  const isCmd = /(?:^|\\)cmd(?:\.exe)?$/i.test(command)
  const resolved = resolveShell(command)
  if (!resolved) {
    return rejectNotFound(command, cmd, args, opts, extra)
  }

  const options = { ...opts, shell: false }
  const realArgs = []
  let script = cmd

  if (isCmd) {
    let doubleEscape = false

    // Decode the executable token so escaped batch shims still get double escaping.
    let initialCmd = ''
    let insideQuotes = false
    for (let i = 0; i < cmd.length; ++i) {
      const char = cmd.charAt(i)
      if (char === '^' && !insideQuotes && i + 1 < cmd.length) {
        initialCmd += cmd.charAt(++i)
        continue
      }
      if (char === ' ' && !insideQuotes) {
        break
      }

      initialCmd += char
      if (char === '"') {
        insideQuotes = !insideQuotes
      }
    }
    if (initialCmd.startsWith('"') && initialCmd.endsWith('"')) {
      initialCmd = initialCmd.slice(1, -1)
    }

    let pathToInitial
    try {
      pathToInitial = which.sync(initialCmd, {
        path: (options.env && findInObject(options.env, 'PATH')) || process.env.PATH,
        pathExt: (options.env && findInObject(options.env, 'PATHEXT')) || process.env.PATHEXT,
      }).toLowerCase()
    } catch (err) {
      pathToInitial = initialCmd.toLowerCase()
    }

    doubleEscape = pathToInitial.endsWith('.cmd') || pathToInitial.endsWith('.bat')
    for (const arg of args) {
      script += ` ${escape.cmd(arg, doubleEscape)}`
    }
    realArgs.push('/d', '/s', '/c', script)
    options.windowsVerbatimArguments = true
  } else {
    for (const arg of args) {
      script += ` ${escape.sh(arg)}`
    }
    realArgs.push('-c', script)
  }

  return promiseSpawn(resolved, realArgs, options, extra)
}

// open a file with the default application as defined by the user's OS
const open = (_args, opts = {}, extra = {}) => {
  const options = { ...opts, shell: true }
  const args = [].concat(_args)

  let platform = process.platform
  // process.platform === 'linux' may actually indicate WSL, if that's the case
  // open the argument with sensible-browser which is pre-installed
  // In WSL, set the default browser using, for example,
  // export BROWSER="/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"
  // or
  // export BROWSER="/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  // To permanently set the default browser, add the appropriate entry to your shell's
  // RC file, e.g. .bashrc or .zshrc.
  if (platform === 'linux' && os.release().toLowerCase().includes('microsoft')) {
    platform = 'wsl'
    if (!process.env.BROWSER) {
      return Promise.reject(
        new Error('Set the BROWSER environment variable to your desired browser.'))
    }
  }

  let command = options.command
  if (!command) {
    if (platform === 'win32') {
      // spawnWithShell does not do the additional os.release() check, so we
      // have to force the shell here to make sure we treat WSL as windows.
      options.shell = process.env.ComSpec
      // also, the start command accepts a title so to make sure that we don't
      // accidentally interpret the first arg as the title, we stick an empty
      // string immediately after the start command
      command = 'start ""'
    } else if (platform === 'wsl') {
      command = 'sensible-browser'
    } else if (platform === 'darwin') {
      command = 'open'
    } else {
      command = 'xdg-open'
    }
  }

  return spawnWithShell(command, args, options, extra)
}
promiseSpawn.open = open

const stdioType = (stdio, fd) => (Array.isArray(stdio) ? stdio[fd] : stdio) ?? 'pipe'

const stdioResult = (stdout, stderr, { stdioString = true, stdio }) => {
  const result = {
    stdout: null,
    stderr: null,
  }

  // stdio is [stdin, stdout, stderr]
  if (stdioType(stdio, 1) === 'pipe') {
    result.stdout = Buffer.concat(stdout)
    if (stdioString) {
      result.stdout = result.stdout.toString().trim()
    }
  }

  if (stdioType(stdio, 2) === 'pipe') {
    result.stderr = Buffer.concat(stderr)
    if (stdioString) {
      result.stderr = result.stderr.toString().trim()
    }
  }

  return result
}

// case insensitive lookup in an object
const findInObject = (obj, key) => {
  key = key.toLowerCase()
  for (const objKey of Object.keys(obj).sort()) {
    if (objKey.toLowerCase() === key) {
      return obj[objKey]
    }
  }
}

module.exports = promiseSpawn
