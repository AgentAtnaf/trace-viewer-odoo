#!/usr/bin/env python3
"""Open a dashboard trace through VS Code Remote using the server's Playwright."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import build_opener, ProxyHandler

KIT = Path(__file__).resolve().parent
PORT = 9323
HTTP = build_opener(ProxyHandler({}))
STATE = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home() / '.cache'))) / 'odoo-trace-viewer'
# Traces are downloaded here and served by the viewer itself. Playwright only serves
# files under its own allowed roots, and with no trace argument that root is simply the
# viewer process's working directory (traceFileRoots() -> [process.cwd()]), so launching
# it with cwd=TRACES turns this directory into the allowlist.
TRACES = STATE / 'traces'
# The viewer must be reached over loopback. Its UI is driven by a service worker, and
# browsers only register one in a secure context: HTTPS, or localhost/127.0.0.1. Served
# from this machine's LAN address the page throws "Service workers are not supported"
# and renders blank, so do not "fix" a forwarding problem by binding the LAN here --
# VS Code forwards this port when `code --openExternal` is given a localhost URL.
VIEWER_BIND = '127.0.0.1'
VIEWER_HOST = 'localhost'
# Keep the cache from growing without bound; traces are tens of megabytes each.
KEEP_TRACES = 12
# The viewer serves its own static assets straight out of this directory, with no
# query string involved. Linking a trace in here lets the page be opened as
# ?trace=<name>.zip, which matters because VS Code's openExternal re-encodes the
# URL it is given: the '?' inside a ?trace=file?path=... value comes back
# double-escaped, so the viewer never sees a query string and reports
# "Could not load trace from file%3Fpath=...". A bare filename has nothing to mangle.
VIEWER_STATIC = KIT / 'node_modules/playwright-core/lib/vite/traceViewer'
LINK_PREFIX = 'odoo-trace-'


def viewer_ready():
    try:
        with HTTP.open(f'http://{VIEWER_BIND}:{PORT}/trace/index.html', timeout=2) as response:
            return b'<title>Playwright Trace Viewer</title>' in response.read(16384)
    except (OSError, ValueError):
        return False


def serves_our_traces():
    # A viewer left over from an older launch answers on the port but was started in a
    # different directory, so it would 403 every trace. Probe a sentinel rather than
    # trusting that the port is up.
    probe_file = TRACES / '.root-probe'
    try:
        probe_file.write_bytes(b'probe')
        with HTTP.open(trace_data_url(probe_file), timeout=5) as response:
            return response.status == 200
    except OSError:
        return False


def stop_stale_viewer():
    # Only ever stop a process this script started and that still looks like the viewer.
    try:
        pid = int((STATE / 'viewer.pid').read_text().strip())
        cmdline = Path(f'/proc/{pid}/cmdline').read_bytes().decode('utf-8', 'replace')
    except (OSError, ValueError):
        return False
    if 'show-trace' not in cmdline:
        return False
    os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        if not Path(f'/proc/{pid}').exists():
            return True
        time.sleep(.1)
    return True


def ensure_viewer():
    TRACES.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (STATE / 'launcher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if viewer_ready():
            if serves_our_traces():
                return
            if not stop_stale_viewer():
                raise RuntimeError(
                    f'Port {PORT} is held by a Trace Viewer this script cannot manage, '
                    f'and it will not serve traces from {TRACES}. Stop it and retry. '
                    f'No process was stopped.'
                )
        else:
            # One of ours may still be bound to a different address; retire it rather
            # than leaving a second viewer behind on the same port.
            stop_stale_viewer()
        with socket.socket() as probe:
            # SO_REUSEADDR so a socket still in TIME_WAIT from the viewer we just
            # stopped is not mistaken for another service holding the port. A process
            # actually listening still makes bind() fail, which is what we want to catch.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((VIEWER_BIND, PORT))
            except OSError:
                raise RuntimeError(
                    f'Port {PORT} is occupied by another service. No process was stopped.')
        cli = KIT / 'node_modules/playwright/cli.js'
        node = shutil.which('node')
        if not node or not cli.is_file():
            raise RuntimeError('The trace kit needs Node.js and its installed Playwright package.')
        with (STATE / 'viewer.log').open('ab') as log:
            process = subprocess.Popen(
                [node, str(cli), 'show-trace', '--host', VIEWER_BIND, '--port', str(PORT)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=str(TRACES),
                start_new_session=True, env={**os.environ, 'CI': '1', 'CODEX_CI': '1'},
            )
        (STATE / 'viewer.pid').write_text(str(process.pid))
        for _ in range(50):
            if viewer_ready():
                return
            if process.poll() is not None:
                break
            time.sleep(.1)
        if process.poll() is None:
            process.terminate()
        raise RuntimeError(f'Could not start Trace Viewer. See {STATE / "viewer.log"}.')


def trace_data_url(path):
    # Same-origin form the viewer serves itself: the path is quoted once here and a
    # second time when it is placed in the ?trace= query parameter.
    return f'http://{VIEWER_BIND}:{PORT}/trace/file?path=' + quote(str(path), safe='')


def link_for_viewer(cached):
    """Expose a cached trace under the viewer's static dir and return its URL name.

    Returns None if that directory is not where this Playwright version keeps it,
    in which case the caller falls back to the file?path= form.
    """
    if not VIEWER_STATIC.is_dir():
        return None
    link = VIEWER_STATIC / (LINK_PREFIX + cached.name)
    try:
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(cached)
    except OSError:
        return None
    prune_viewer_links(keep=link)
    return link.name


def prune_viewer_links(keep=None):
    # Drop links whose cached trace is gone, so npm-managed directory stays tidy.
    try:
        links = list(VIEWER_STATIC.glob(LINK_PREFIX + '*.zip'))
    except OSError:
        return
    for link in links:
        if link == keep:
            continue
        try:
            if not link.resolve().is_file():
                link.unlink()
        except OSError:
            continue


def cache_trace(trace_url):
    # Fetch server-side, so the browser never has to reach the dashboard's own address.
    TRACES.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = TRACES / (hashlib.sha256(trace_url.encode()).hexdigest()[:16] + '.zip')
    partial = target.with_suffix('.part')
    with HTTP.open(trace_url, timeout=60) as response:
        # A run's artifacts are immutable, so an identically sized cache entry is the
        # same trace: reuse it instead of rewriting tens of megabytes on every click.
        declared = response.headers.get('Content-Length')
        if declared and target.is_file() and target.stat().st_size == int(declared):
            target.touch()
            prune_traces(keep=target)
            return target
        head = response.read(4)
        if head != b'PK\x03\x04':
            raise RuntimeError('The selected artifact did not return a trace ZIP.')
        with partial.open('wb') as out:
            out.write(head)
            shutil.copyfileobj(response, out)
    partial.replace(target)
    prune_traces(keep=target)
    return target


def prune_traces(keep):
    try:
        zips = sorted(TRACES.glob('*.zip'), key=lambda f: f.stat().st_mtime, reverse=True)
    except OSError:
        return
    for stale in zips[KEEP_TRACES:]:
        if stale != keep:
            stale.unlink(missing_ok=True)


def find_code_cli():
    # PATH only carries the remote CLI inside a VS Code terminal. Anything started by
    # systemd, cron or a plain `ssh host cmd` gets a bare PATH and would otherwise fail
    # here even though VS Code is connected, so fall back to the ~/.vscode-server
    # layouts. Newest install first: the commit hash in the path changes on every
    # VS Code update and old installs linger.
    on_path = shutil.which('code')
    if on_path:
        return on_path
    root = Path.home() / '.vscode-server'
    candidates = []
    for pattern in ('cli/servers/*/server/bin/remote-cli/code', 'bin/*/bin/remote-cli/code'):
        for candidate in root.glob(pattern):
            try:
                candidates.append((candidate.stat().st_mtime, candidate))
            except OSError:
                continue
    for _, candidate in sorted(candidates, reverse=True):
        if os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def ipc_hook_alive(path):
    if not path:
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(2)
            probe.connect(path)
        return True
    except OSError:
        return False


def find_live_ipc_hook():
    # The env var this process inherited is frozen at whatever VS Code session was live when
    # the *dashboard server* started; it never updates on reconnect/reopen. So re-scan the
    # runtime dir every call and use whichever socket answers right now, newest first.
    candidates = []
    env_hook = os.environ.get('VSCODE_IPC_HOOK_CLI')
    if env_hook:
        candidates.append(Path(env_hook))
    try:
        run_dir = Path(f'/run/user/{os.getuid()}')
        candidates.extend(sorted(run_dir.glob('vscode-ipc-*.sock'), key=lambda p: p.stat().st_mtime, reverse=True))
    except OSError:
        pass
    seen = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if ipc_hook_alive(key):
            return key
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('trace_url')
    parser.add_argument('--no-open', action='store_true', help='Print the viewer URL without opening a browser')
    args = parser.parse_args()
    url = urlsplit(args.trace_url)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
        parser.error('Pass the plain HTTP(S) trace URL, without Markdown link formatting.')
    code = None if args.no_open else find_code_cli()
    ipc_hook = None if args.no_open else find_live_ipc_hook()
    # Two different failures that used to share one (often wrong) message: a missing
    # CLI is an environment problem, a missing socket means nobody is connected.
    if not args.no_open and not code:
        raise RuntimeError(
            'Could not find the VS Code remote CLI ("code") under ~/.vscode-server. '
            'Pass --no-open to just get the viewer URL.'
        )
    if not args.no_open and not ipc_hook:
        raise RuntimeError(
            f'No VS Code Remote session is currently connected to {socket.gethostname()}. '
            'Open (or reopen) VS Code connected to it, then retry — or pass '
            '--no-open to just get the viewer URL.'
        )
    # Download it here and let the viewer serve it from its own port. Handing the
    # browser the dashboard's address instead makes the page fetch cross-origin, from
    # localhost into a private network, which stalls in the browser rather than failing.
    # Never save outside the cache directory, and never execute the contents.
    ensure_viewer()
    cached = cache_trace(args.trace_url)
    link_name = link_for_viewer(cached)
    trace_param = link_name or ('file?path=' + quote(str(cached), safe=''))
    viewer = f'http://{VIEWER_HOST}:{PORT}/trace/index.html?' + urlencode({'trace': trace_param})
    if not args.no_open:
        try:
            subprocess.run(
                [code, '--openExternal', viewer], check=True, timeout=20,
                capture_output=True, text=True, env={**os.environ, 'VSCODE_IPC_HOOK_CLI': ipc_hook},
            )
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or '').strip()
            if 'ECONNREFUSED' in detail or 'vscode-ipc' in detail:
                raise RuntimeError(
                    'The VS Code session went stale between checking and opening the trace. Retry.'
                ) from error
            raise RuntimeError(f'VS Code refused to open the trace: {detail or error}') from error
        print('Asked VS Code to open the selected trace in your browser.')
    print(viewer)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f'Trace Viewer: {error}', file=sys.stderr)
        sys.exit(1)
