#!/usr/bin/env bash
set -euo pipefail
export TLAPM=${TLAPM:-tlapm}
export TLA2TOOLS_JAR=${TLA2TOOLS_JAR:-/missing/tla2tools.jar}
export READ_HEAD_ROUTING_ROOT="$(cd "$(dirname "$0")" && pwd)"
python3 - <<'PY'
import gzip, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path
root = Path(os.environ['READ_HEAD_ROUTING_ROOT'])
tlapm = shutil.which(os.environ['TLAPM'])
jar = Path(os.environ['TLA2TOOLS_JAR']).resolve()
if tlapm is None or not jar.is_file():
    sys.exit('Set TLAPM and TLA2TOOLS_JAR to installed, verified tools; see specs/README.md')
proof = (root / 'ReadHeadRoutingProofs.tla').read_text()
if re.search(r'\b(?:OMITTED|ADMITTED|AXIOM)\b', proof):
    sys.exit('No omitted/admitted proofs or new axioms permitted')
sources = [root / n for n in ['ReadHeadPublication.tla', 'ReadHeadRouting.tla', 'ReadHeadRoutingProofs.tla', 'ReadHeadRouting.safe.cfg']]
config = (root / 'ReadHeadRouting.safe.cfg').read_text()
results, logs = {}, {}
with tempfile.TemporaryDirectory(prefix='poneglyph-head-routing-') as temporary:
    work = Path(temporary)
    def case(name, mutation=None):
        target = work / name
        target.mkdir()
        for source in sources:
            shutil.copyfile(source, target / source.name)
        if mutation:
            before, after = mutation
            p = target / 'ReadHeadRouting.tla'
            text = p.read_text()
            if text.count(before) != 1:
                raise RuntimeError(name + ': mutation must match exactly once')
            p.write_text(text.replace(before, after))
        return target
    def execute(name, args, target):
        started = time.monotonic()
        try:
            result = subprocess.run(args, cwd=target, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=90)
        except subprocess.TimeoutExpired as error:
            output = error.stdout or b''
            logs[name + '.log'] = output.decode() if isinstance(output, bytes) else output
            raise RuntimeError(name + ': timed out; incomplete, not a passing check')
        logs[name + '.log'] = result.stdout
        return result, round(time.monotonic() - started, 3)
    def prove(name, mutation=None, target_by=None):
        target = case(name, mutation)
        result, seconds = execute(name, [tlapm, '--strict', '--nofp', '--threads', '1', '--cache-dir', str(target / 'cache'), 'ReadHeadRoutingProofs.tla'], target)
        if mutation:
            line = proof[:proof.index(target_by)].count('\n') + 1
            if result.returncode == 0 or 'obligations failed' not in result.stdout or not re.search(r'line ' + str(line) + r', characters .*?\n\[ERROR\]: Could not prove or check:', result.stdout):
                raise RuntimeError(name + ': intended theorem did not fail')
            results[name] = {'status': 'expected-proof-failure', 'seconds': seconds}
        else:
            match = re.search(r'All (\d+) obligations proved', result.stdout)
            if result.returncode != 0 or match is None or int(match[1]) < 10:
                raise RuntimeError(name + ': strict proof did not discharge')
            results[name] = {'status': 'proved', 'obligations': int(match[1]), 'seconds': seconds}
        print(name + ': ' + results[name]['status'], flush=True)
    def tlc(name, cfg=config, violation=None, mutation=None):
        target = case(name, mutation)
        (target / 'run.cfg').write_text(cfg)
        result, seconds = execute(name, ['java', '-Xmx3g', '-XX:+UseParallelGC', '-cp', str(jar), 'tlc2.TLC', '-workers', '1', '-config', 'run.cfg', 'ReadHeadRouting'], target)
        if violation:
            if result.returncode == 0 or 'Invariant ' + violation + ' is violated' not in result.stdout:
                raise RuntimeError(name + ': intended counterexample absent')
            status = 'expected-counterexample'
        else:
            if result.returncode != 0 or 'Model checking completed. No error has been found.' not in result.stdout:
                raise RuntimeError(name + ': exploration did not complete successfully')
            status = 'checked'
        count = re.search(r'(\d+) states generated, (\d+) distinct states found', result.stdout)
        results[name] = {'status': status, 'seconds': seconds}
        if count:
            results[name].update(generated=int(count[1]), distinct=int(count[2]))
        print(name + ': ' + status, flush=True)
    head_guard = ('(GuardReadHeadAuthority => ProbeMatches)', '(GuardReadHeadAuthority => TRUE)')
    identity_guard = ('SameProjection(q.cached, s.heads[q.selected].committed, q.scope)', 'TRUE')
    canonical_guard = ('IF GuardCanonicalFallback THEN s.revision ELSE q.cached', 'q.cached')
    try:
        prove('routing-proof')
        prove('ignore-head-authority-proof', head_guard, 'BY SMT DEF RoutingType, TypeOK, ConditionalReadsCurrent')
        prove('ignore-cache-identity-proof', identity_guard, 'BY SMT DEF RoutingType, TypeOK, ConditionalReadsCurrent')
        prove('stale-canonical-fallback-proof', canonical_guard, 'BY SMT DEF RoutingType, TypeOK, CompleteFromCanonical')
        tlc('routing-safety')
        tlc('ignore-head-authority', config.replace('GuardReadHeadAuthority = TRUE', 'GuardReadHeadAuthority = FALSE'), 'RoutingSafety')
        tlc('ignore-cache-identity', violation='RoutingSafety', mutation=identity_guard)
        tlc('stale-canonical-fallback', config.replace('GuardCanonicalFallback = TRUE', 'GuardCanonicalFallback = FALSE'), 'RoutingSafety')
        for invariant in ['NoHeadWithoutCanonical', 'NoFrozenHeadHit', 'NoRetiredHintFallback', 'NoFailedQuery']:
            cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + invariant, config, flags=re.MULTILINE)
            tlc('witness-' + invariant, cfg, invariant)
        print('Routing composition proved under explicit type/global-head premises; bounded safety and deliberate counterexamples checked. No implementation, latency or unconditional availability proof.', flush=True)
    finally:
        destination = os.environ.get('READ_HEAD_ROUTING_EVIDENCE_DIR')
        if destination:
            out = Path(destination); out.mkdir(parents=True, exist_ok=True)
            for name, text in logs.items():
                (out / (name + '.gz')).write_bytes(gzip.compress(text.encode(), mtime=0))
            for source in sources + [root / 'check-read-head-routing.sh']:
                (out / (source.name + '.gz')).write_bytes(gzip.compress(source.read_bytes(), mtime=0))
            (out / 'summary.json').write_text(json.dumps(results, indent=2) + '\n')
            (out / 'hashes.json').write_text(json.dumps({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.name != 'hashes.json'}, indent=2) + '\n')
PY
