#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
export TLAPM=${TLAPM:-tlapm}
python3 - "$root" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
executable = shutil.which(os.environ['TLAPM'])
if executable is None:
    sys.exit('Set TLAPM to an installed tlapm executable (see specs/README.md)')

def invoke(args, cwd, timeout=90):
    return subprocess.run([executable, *args], cwd=cwd, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          timeout=timeout)

sources = ['ReadHeadPublication.tla', 'ReadHeadKernelProofs.tla']
proof = (root / sources[1]).read_text()
if re.search(r'\b(?:OMITTED|ADMITTED|AXIOM)\b', proof):
    sys.exit('Proof entrypoint must not contain omitted/admitted proofs or new axioms')

with tempfile.TemporaryDirectory(prefix='poneglyph-tlaps-') as temporary:
    work = Path(temporary)
    version = invoke(['--version'], work).stdout.strip()
    config = invoke(['--config'], work).stdout
    backend = re.search(r'^SMT version == "([^"]+)"', config, re.MULTILINE)
    results = {}
    logs = {}
    positive = None
    mutations = [
        ('positive', None, None, None),
        ('no-activation-fence',
         '(~GuardActivationFence \\/ h.generation = c.generation)', 'TRUE',
         'ActivationRejectsStaleGeneration'),
        ('revive-retired-head',
         'THEN [h EXCEPT !.generation = c.generation, !.mode = "retired"] ELSE h',
         'THEN [h EXCEPT !.generation = c.generation, !.mode = "serving"] ELSE h',
         'RetirementIsIrreversible'),
        ('unconditional-frozen-validation',
         'SameProjection(h.committed, h.prepared, scope))', 'TRUE)',
         'FrozenValidationSound'),
    ]
    for name, before, after, theorem in mutations:
        case = work / name
        case.mkdir()
        model = (root / sources[0]).read_text()
        if before is not None:
            if model.count(before) != 1:
                sys.exit(f'{name}: mutation no longer matches one model location')
            model = model.replace(before, after)
        (case / sources[0]).write_text(model)
        (case / sources[1]).write_text(proof)
        result = invoke(['--strict', '--nofp', '--method', 'smt', '--threads', '1',
                         '--cache-dir', str(case / 'cache'), sources[1]], case)
        logs[name + '.log'] = result.stdout
        if name == 'positive':
            proved = re.search(r'All (\d+) obligations proved', result.stdout)
            if result.returncode != 0 or proved is None or int(proved[1]) < 3:
                sys.stderr.write(result.stdout)
                sys.exit('Positive proof did not discharge all obligations')
            positive = int(proved[1])
            results[name] = {'status': 'proved', 'obligations': positive}
        else:
            body = proof[proof.index('THEOREM ' + theorem):]
            proof_line = proof[:proof.index('THEOREM ' + theorem)].count('\n') + body[:body.index('BY ')].count('\n') + 1
            at_target = re.search(r'line ' + str(proof_line) + r', characters .*?\n\[ERROR\]: Could not prove or check:', result.stdout)
            if (result.returncode == 0 or at_target is None or
                'obligations failed' not in result.stdout):
                sys.stderr.write(result.stdout)
                sys.exit(f'{name}: did not fail the intended theorem')
            results[name] = {'status': 'expected-proof-failure', 'theorem': theorem,
                             'exitCode': result.returncode}
        print(f'{name}: {results[name]["status"]}', flush=True)

    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
              for name in [*sources, 'check-tlaps.sh']}
    evidence = {'tool': 'TLAPS/tlapm', 'version': version,
                'backend': backend[1] if backend else 'not-reported',
                'mode': 'strict, fresh fingerprints, SMT; no Isabelle certificate recheck',
                'scope': 'Three local read-head lemmas; not whole-protocol safety, liveness, batching, implementation or performance',
                'sourceSha256': hashes, 'results': results}
    destination = os.environ.get('TLAPS_EVIDENCE_DIR')
    if destination:
        target = Path(destination).resolve()
        target.mkdir(parents=True, exist_ok=True)
        for name, text in logs.items():
            (target / name).write_text(text)
        (target / 'summary.json').write_text(json.dumps(evidence, indent=2) + '\n')
        for name in sources:
            shutil.copyfile(root / name, target / name)
    print(f'{positive} obligations proved; three weakened-model controls rejected')
    print(evidence['scope'])
PY
