# @npmcli/promise-spawn

Spawn processes the way the npm cli likes to do.  Give it some options,
it'll give you a Promise that resolves or rejects based on the results of
the execution.

## USAGE

```js
const promiseSpawn = require('@npmcli/promise-spawn')

promiseSpawn('ls', [ '-laF', 'some/dir/*.js' ], {
  cwd: '/tmp/some/path', // defaults to process.cwd()
  stdioString: true, // stdout/stderr as strings rather than buffers
  stdio: 'pipe', // any node spawn stdio arg is valid here
  // any other arguments to node child_process.spawn can go here as well,
}, {
  extra: 'things',
  to: 'decorate',
  the: 'result',
}).then(result => {
  // {code === 0, signal === null, stdout, stderr, and all the extras}
  console.log('ok!', result)
}).catch(er => {
  // er has all the same properties as the result, set appropriately
  console.error('failed!', er)
})
```

## API

### `promiseSpawn(cmd, args, opts, extra)` -> `Promise`

Run the command, return a Promise that resolves/rejects based on the
process result.

Result or error will be decorated with the properties in the `extra`
object.  You can use this to attach some helpful info about _why_ the
command is being run, if it makes sense for your use case.

If `stdio` is set to anything other than `'inherit'`, then the result/error
will be decorated with `stdout` and `stderr` values.  If `stdioString` is
set to `true`, these will be strings.  Otherwise they will be Buffer
objects.

For piped input, `promise.stdin` is the writable stream at
`promise.process.stdin`. If shell lookup fails, piped stdin discards input
and piped stdout and stderr end without data. Non-piped handles are `null`.
The process emits `error` with the same error that rejects the promise, then
`exit`. It emits `close` after its standard pipes close.

#### Options

- `stdioString` Boolean, default `true`.  Return stdout/stderr output as
  strings rather than buffers.
- `cwd` String, default `process.cwd()`.  Current working directory for
  running the script.
- `shell` Boolean or String. If false, no shell is used during spawn. If true,
  the system default shell is used. If a String, that specific shell is used.
  When a shell is used, the given command runs from within that shell by
  concatenating the command and its escaped arguments and running the result.
  An explicit shell path is used as provided. For a bare name, lookup uses the
  parent process's `PATH` (`process.env.PATH`), never `opts.env.PATH`. Relative
  entries resolve against `process.cwd()` before `opts.cwd` takes effect.
  On POSIX, quotes are literal and an empty entry in a nonempty `PATH` means
  the current directory. On Windows, the variable name is case-insensitive
  even in workers. Lookup skips empty entries and accepts single or double
  quotes around directories containing semicolons. It tries `.COM` then `.EXE`
  in each listed directory. Commands inside `cmd.exe` still use `PATHEXT`.
  For a bare shell name, the promise rejects with `ENOENT` if the parent
  `PATH` is unset, empty, or contains no matching executable. This option is
  _not_ passed through to `child_process.spawn`.
- Any other options for `child_process.spawn` can be passed as well.

### `promiseSpawn.open(arg, opts, extra)` -> `Promise`

Use the operating system to open `arg` with a default program. This is useful
for things like opening the user's default browser to a specific URL.

Depending on the platform in use this will use `start` (win32), `open` (darwin)
or `xdg-open` (everything else). In the case of Windows Subsystem for Linux we
use the default win32 behavior as it is much more predictable to open the arg
using the host operating system.

#### Options

Options are identical to `promiseSpawn` except for the following:

- `command` String, the command to use to open the file in question. Default is
   one of `start`, `open` or `xdg-open` depending on platform in use.
