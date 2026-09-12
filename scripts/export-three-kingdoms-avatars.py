"""Freeze V2.3 production avatars: V2.2 roster + five approved V2.3 portraits.

Run with Python/Pillow from the project checkout containing design source assets.
Generated frontend catalog and backend allowlist are committed with the WebPs.
Never overwrite this release's paths with a different future design.
"""
from pathlib import Path
import hashlib, json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DESIGN = ROOT / 'design-system/monexus/generated'
BASE = DESIGN / 'three-kingdoms-24-v2.2'
REVISION = DESIGN / 'three-kingdoms-5-v2.3'
PREFIX = '/assets/avatars/three-kingdoms/v2.3'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def main():
    originals = json.loads((BASE / 'manifest.json').read_text())['avatars']
    revisions = {a['id']: a for a in json.loads((REVISION / 'manifest.json').read_text())['avatars']}
    catalog, provenance = [], []
    for avatar in originals:
        ident = avatar['id']
        source = (REVISION / revisions[ident]['exports']['443png']['file']) if ident in revisions else BASE / avatar['png']
        im = Image.open(source).convert('RGB')
        assert im.size == (443, 443)
        item = {'id': ident, 'name': avatar['name'], 'faction': avatar['faction']}
        assets = []
        for side, field in [(443, 'url'), (96, 'thumbnailUrl'), (48, 'smallUrl')]:
            url = f'{PREFIX}/' + (f'{side}/' if side != 443 else '') + ident + '.webp'
            dest = ROOT / 'public' / url.lstrip('/')
            dest.parent.mkdir(parents=True, exist_ok=True)
            resized = im if side == 443 else im.resize((side, side), Image.Resampling.LANCZOS)
            resized.save(dest, lossless=True, method=6)
            assert Image.open(dest).convert('RGB').tobytes() == resized.tobytes()
            item[field] = url
            assets.append({'url': url, 'width': side, 'sha256': sha(dest), 'bytes': dest.stat().st_size})
        catalog.append(item)
        provenance.append({'id': ident, 'name': avatar['name'], 'faction': avatar['faction'], 'source': str(source.relative_to(ROOT)), 'sourceSha256': sha(source), 'assets': assets})
    assert len(catalog) == 24 and len({a['id'] for a in catalog}) == 24
    assert all(sum(a['faction'] == f for a in catalog) == 8 for f in ['wei', 'shu', 'wu'])
    write_json(ROOT / 'src/data/avatarPresets.json', catalog)
    write_json(ROOT / 'server/src/modules/auth/avatarPresetUrls.json', [a['url'] for a in catalog])
    write_json(ROOT / 'docs/assets/three-kingdoms-v2.3.json', {'version': '2.3', 'avatars': provenance})
    print(f'Exported 24 portraits, 72 lossless WebPs, {sum(f["bytes"] for a in provenance for f in a["assets"]):,} bytes')

if __name__ == '__main__':
    main()
