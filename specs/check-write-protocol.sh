#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
export TLAPM=${TLAPM:-tlapm}
python3 - "$root" <<'PY'
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

root = Path(sys.argv[1])
tlapm = shutil.which(os.environ['TLAPM'])
jar = Path(os.environ.get('TLA2TOOLS_JAR', '/missing/tla2tools.jar')).resolve()
if tlapm is None or not jar.is_file():
    sys.exit('Set TLAPM and TLA2TOOLS_JAR to installed, verified tools; see specs/README.md')
sources = sorted([*root.glob('Write*.tla'), *root.glob('Write*.cfg')])
for source in sources:
    if source.name.endswith('Proofs.tla') and re.search(r'\b(?:OMITTED|ADMITTED|AXIOM)\b', source.read_text()):
        sys.exit(f'{source.name}: no omitted/admitted proofs or new axioms permitted')
logs, results = {}, {}

def execute(name, args, directory, timeout=180):
    start = time.monotonic()
    try:
        r = subprocess.run(args, cwd=directory, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        text = error.stdout or b''
        logs[name + '.log'] = text.decode() if isinstance(text, bytes) else text
        raise RuntimeError(name + ': timed out; incomplete, not a passing check')
    logs[name + '.log'] = r.stdout
    return r, round(time.monotonic() - start, 3)

with tempfile.TemporaryDirectory(prefix='poneglyph-write-models-') as temporary:
    work = Path(temporary)
    def case(name):
        target = work / name
        target.mkdir()
        for source in sources:
            shutil.copyfile(source, target / source.name)
        return target
    def prove(name, entry, mutation=None, expected_line=None):
        target = case(name)
        if mutation:
            path, before, after = mutation
            text = (target / path).read_text()
            if text.count(before) != 1:
                raise RuntimeError(name + ': mutation must match exactly once')
            (target / path).write_text(text.replace(before, after))
        r, duration = execute(name, [tlapm, '--strict', '--nofp', '--threads', '1',
                                    '--cache-dir', str(target / 'cache'), entry], target)
        if mutation:
            if (r.returncode == 0 or 'obligations failed' not in r.stdout or
                not re.search(r'line ' + str(expected_line) + r', characters .*?\n\[ERROR\]: Could not prove or check:', r.stdout)):
                raise RuntimeError(name + ': intended theorem did not fail')
            results[name] = {'status': 'expected-proof-failure', 'seconds': duration}
        else:
            match = re.search(r'All (\d+) obligations proved', r.stdout)
            if r.returncode != 0 or match is None or int(match[1]) < 8:
                raise RuntimeError(name + ': obligations did not all discharge')
            results[name] = {'status': 'proved', 'obligations': int(match[1]), 'seconds': duration}
        print(name + ': ' + results[name]['status'], flush=True)
    def tlc(name, module, config, invariant=None):
        target = case(name)
        (target / 'run.cfg').write_text(config)
        r, duration = execute(name, ['java', '-Xmx3g', '-XX:+UseParallelGC', '-cp', str(jar),
                                     'tlc2.TLC', '-workers', '1', '-config', 'run.cfg', module], target)
        if invariant:
            if r.returncode == 0 or 'Invariant ' + invariant + ' is violated' not in r.stdout:
                raise RuntimeError(name + ': intended invariant counterexample absent')
            status = 'expected-counterexample'
        else:
            if r.returncode != 0 or 'Model checking completed. No error has been found.' not in r.stdout:
                raise RuntimeError(name + ': exploration did not complete successfully')
            status = 'checked'
        count = re.search(r'(\d+) states generated, (\d+) distinct states found', r.stdout)
        results[name] = {'status': status, 'seconds': duration}
        if count:
            results[name].update(generated=int(count[1]), distinct=int(count[2]))
        print(name + ': ' + status, flush=True)
    def only_invariant(config, invariant):
        return re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + invariant, config, flags=re.MULTILINE)

    error = None
    try:
        prove('core-proof', 'WritePublicationCoreProofs.tla')
        prove('batch-refinement-proof', 'WriteBatchRefinementProofs.tla')
        core = 'WritePublicationCore.tla'
        proof = (root / 'WritePublicationCoreProofs.tla').read_text()
        for name, before, after, theorem in [
            ('conflicting-decision', '/\\ C \\cap s.aborted = {} /\\ R \\cap s.committed = {}', '/\\ TRUE', 'DecidePreserves'),
            ('early-publication', '/\\ \\A o \\in Owners : (B \\cap OwnerTxns(o)) \\subseteq s.effects[o]', '/\\ TRUE', 'PublishPreserves'),
            ('early-ack', '/\\ B \\subseteq s.published', '/\\ B \\subseteq s.committed', 'AckPreserves'),
        ]:
            offset = proof.index('THEOREM ' + theorem)
            proof_line = proof[:offset + proof[offset:].index('BY ')].count('\n') + 1
            prove(name, 'WritePublicationCoreProofs.tla', (core, before, after), proof_line)
        batch_proof = (root / 'WriteBatchRefinementProofs.tla').read_text()
        offset = batch_proof.index('THEOREM IndependentDecision')
        proof_line = batch_proof[:offset + batch_proof[offset:].index('BY ')].count('\n') + 1
        prove('poison-batch-proof', 'WriteBatchRefinementProofs.tla',
              ('WriteBatchProtocol.tla',
               'THEN Decide(Good(g), Bad(g)) ELSE Decide({}, Members[g])',
               'THEN Decide({}, Members[g]) ELSE Decide({}, Members[g])'), proof_line)
        tlc('core-tlc', 'WritePublicationCoreMC.tla', (root / 'WritePublicationCoreMC.cfg').read_text())
        base = (root / 'WriteBatchProtocol.safe.cfg').read_text()
        tlc('batch-safety', 'WriteBatchProtocolMC.tla', base)
        tlc('batch-recovery-progress', 'WriteBatchProtocolMC.tla', (root / 'WriteBatchProtocol.recovery.cfg').read_text())
        for name, guard, invariant in [
            ('partial-vector', 'GuardClosed', 'CutMatchesPublication'),
            ('premature-reply', 'GuardReply', 'CoreSafety'),
            ('poison-batch', 'GuardIndependent', 'DecisionsIndependent'),
            ('duplicate-apply', 'GuardExactlyOnce', 'NoDuplicateEffects'),
            ('duplicate-publication', 'GuardPublishReplay', 'FrontierWithinOwner'),
            ('overwrite-projection', 'Incremental', 'ProjectionMatchesFacts'),
            ('stale-plan', 'GuardEpoch', 'PreparedEpochsCurrent'),
        ]:
            cfg = only_invariant(base, invariant).replace(guard + ' = TRUE', guard + ' = FALSE')
            if guard == 'GuardEpoch':
                cfg = cfg.replace('MaxEpoch = 0', 'MaxEpoch = 1')
            tlc(name, 'WriteBatchProtocolMC.tla', cfg, invariant)
        for invariant in ['NoMixedBatch', 'NoDisjointExecution', 'NoAdmissionRejection', 'NoLostReply', 'NoUnconfirmedPublication', 'NoAggregateScaling']:
            cfg = only_invariant(base, invariant)
            if invariant == 'NoAdmissionRejection':
                cfg = cfg.replace('MaxActive = 2', 'MaxActive = 1')
            tlc('witness-' + invariant, 'WriteBatchProtocolMC.tla', cfg, invariant)
    except Exception as caught:
        error = str(caught)
    evidence = {'status': 'failed' if error else 'passed', 'error': error,
        'tlapm': subprocess.check_output([tlapm, '--version'], text=True).strip(),
        'tla2toolsSha256': hashlib.sha256(jar.read_bytes()).hexdigest(),
        'sourceSha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in [*sources, root / 'check-write-protocol.sh']},
        'scope': 'Semantic core and batch-to-core refinement proved; numeric cuts, epochs, projection counts, admission and fair recovery checked in bounded TLC instances. No implementation or latency proof.',
        'results': results}
    destination = os.environ.get('WRITE_PROTOCOL_EVIDENCE_DIR')
    if destination:
        target = Path(destination).resolve()
        target.mkdir(parents=True, exist_ok=True)
        for name, text in logs.items():
            (target / (name + '.gz')).write_bytes(gzip.compress(text.encode(), mtime=0))
        for source in [*sources, root / 'check-write-protocol.sh']:
            (target / (source.name + '.gz')).write_bytes(gzip.compress(source.read_bytes(), mtime=0))
        (target / 'summary.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if error:
        print(logs[next(reversed(logs))], file=sys.stderr)
        sys.exit(error)
    print(evidence['scope'])
PY
