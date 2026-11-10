#!/usr/bin/env python3
"""Fetch verified official fixed-version artifacts; no host MAA installation required."""
import pathlib,hashlib,json,urllib.request,tarfile,tempfile,shutil,os
root=pathlib.Path(__file__).resolve().parent.parent
vendor=root/'vendor';vendor.mkdir(exist_ok=True)
if (vendor/'maa-runtime.tar.gz').exists():
    print('Existing pinned runtime retained');raise SystemExit(0)
lock=json.loads((root/'runtime.lock.json').read_text())
with tempfile.TemporaryDirectory() as tmp:
    tmp=pathlib.Path(tmp);stage=tmp/'stage';(stage/'bin').mkdir(parents=True);(stage/'share/lib').mkdir(parents=True)
    for kind in ['cli','core']:
        artifact=tmp/(kind+'.tar.gz');print('Downloading',kind,lock[kind]['version'],flush=True)
        urllib.request.urlretrieve(lock[kind]['url'],artifact)
        digest=hashlib.file_digest(artifact.open('rb'),'sha256').hexdigest()
        assert digest==lock[kind]['sha256'], f'{kind} checksum mismatch'
        directory=tmp/kind;directory.mkdir()
        with tarfile.open(artifact) as t:t.extractall(directory,filter='data')
        if kind=='cli':
            candidates=[p for p in directory.rglob('maa') if p.is_file()]
            assert len(candidates)==1, 'Ambiguous CLI archive';shutil.copy2(candidates[0],stage/'bin/maa');os.chmod(stage/'bin/maa',0o755)
        else:
            # The MAA release archive ships the complete resource tree as `<extract>/resource`
            # (nested `tasks/tasks.json` or a flat `tasks.json`). Per-client/per-platform overlays
            # also live in directories named `resource`; selecting one of those would silently
            # replace the base resource with a small overlay, so prefer the archive's own tree.
            def complete(p):
                return any((p/rel).exists() for rel in ['tasks/tasks.json','tasks.json']) and \
                    (p/'template').is_dir() and \
                    sum((p/name).exists() for name in ['PaddleOCR','PaddleCharOCR','onnx','config.json','stages.json','infrast.json'])>=4
            candidates=[p for p in directory.rglob('resource') if p.is_dir() and complete(p)]
            assert candidates, 'Cannot identify a complete resource directory'
            # Prefer the shallowest complete tree (the archive root resource), never a platform overlay.
            candidates.sort(key=lambda p:(len(p.parts),str(p)))
            shutil.copytree(candidates[0],stage/'share/resource')
            nested=(stage/'share/resource'/'tasks'/'tasks.json').exists()
            flat=(stage/'share/resource'/'tasks.json').exists()
            assert nested or flat, 'Bundled resource has no task data'
            print('resource layout:', 'tasks/tasks.json' if nested else 'tasks.json')
            libraries=[p for p in directory.rglob('*') if p.is_file() and ('.so' in p.name)]
            assert any(p.name=='libMaaCore.so' for p in libraries), 'Missing MaaCore'
            for p in libraries:shutil.copy2(p,stage/'share/lib'/p.name)
    output=vendor/'maa-runtime.tar.gz'
    with tarfile.open(output,'w:gz') as t:
        t.add(stage/'bin',arcname='bin');t.add(stage/'share',arcname='share')
    digest=hashlib.file_digest(output.open('rb'),'sha256').hexdigest()
    (vendor/'maa-runtime.sha256').write_text(digest+'  maa-runtime.tar.gz\n')
    (vendor/'maa-version.txt').write_text('Official artifacts from runtime.lock.json\n')
print('Verified runtime ready')
