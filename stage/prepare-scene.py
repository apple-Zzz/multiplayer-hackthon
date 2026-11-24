#!/usr/bin/env python3
"""Scene assets for the 2D stage.

1. Cuts the boat and shelter illustrations (black background) into transparent sprites:
   public/stage/boat.png, public/stage/shelter.png (+ sizes in public/stage/scene.json).
2. Builds a dry-sand map from the beach background: water and foam (plus a safety
   margin) are off-limits. Saved as a 4-px grid in public/stage/scene.json so the stage
   can keep every walk on dry sand and the verifier can check every footstep.

  python3 stage/prepare-scene.py [--preview]
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'assets', 'source')
OUT = os.path.join(ROOT, 'public', 'stage')
CELL = 4          # grid resolution (stage px)
MARGIN = 18       # keep feet at least this far from foam/water (stage px)


def cutout(name):
    img = np.asarray(Image.open(os.path.join(SRC, f'{name}.jpg')).convert('RGB'))
    mask = ndi.binary_closing(img.max(2) > 12, iterations=2)
    lab, n = ndi.label(mask)
    sizes = ndi.sum(mask, lab, range(1, n + 1))
    keep = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s > sizes.max() * 0.01])
    keep = ndi.binary_fill_holes(keep)
    ys, xs = np.where(keep)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    rgba = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
    rgba[..., :3] = img[y0:y1, x0:x1]
    alpha = Image.fromarray((keep[y0:y1, x0:x1] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    rgba[..., 3] = np.asarray(alpha)
    out = Image.fromarray(rgba, 'RGBA')
    out.save(os.path.join(OUT, f'{name}.png'))
    return {'src': f'/stage/{name}.png', 'w': out.width, 'h': out.height}


def dry_sand():
    bg = np.asarray(Image.open(os.path.join(SRC, 'beach.jpg')).convert('RGB')).astype(int)
    r, g, b = bg[..., 0], bg[..., 1], bg[..., 2]
    water = (b > r + 60)                                        # cyan sea
    foam = (r > 225) & (g > 225) & (b > 200)                    # surf line
    wet = ndi.binary_dilation(water | foam, iterations=MARGIN)  # safety margin
    sand = (r > 200) & (g > 140) & (g < 225) & (b < 160)        # orange sand
    sand = ndi.binary_opening(sand, iterations=2)
    dry = sand & ~wet
    H, W = dry.shape
    gh, gw = H // CELL, W // CELL
    grid = dry[:gh * CELL, :gw * CELL].reshape(gh, CELL, gw, CELL).all(axis=(1, 3))
    return dry, grid


def main():
    os.makedirs(OUT, exist_ok=True)
    sprites = {'boat': cutout('boat'), 'shelter': cutout('shelter')}
    dry, grid = dry_sand()
    scene = {
        'size': [dry.shape[1], dry.shape[0]],
        'sprites': sprites,
        'dry': {'cell': CELL, 'w': grid.shape[1], 'h': grid.shape[0],
                'rows': [''.join('1' if v else '0' for v in row) for row in grid]},
    }
    with open(os.path.join(OUT, 'scene.json'), 'w') as f:
        json.dump(scene, f)
    print('sprites', sprites)
    print('dry sand cells:', int(grid.sum()), 'of', grid.size)

    def is_dry(x, y):
        return bool(grid[int(y) // CELL, int(x) // CELL]) if 0 <= y < dry.shape[0] and 0 <= x < dry.shape[1] else False
    # report the anchors/markers the stage uses
    probes = json.loads(sys.argv[sys.argv.index('--probe') + 1]) if '--probe' in sys.argv else {}
    for k, (x, y) in probes.items():
        print(f'  {k:>16} ({x},{y}) dry={is_dry(x, y)}')
    if '--preview' in sys.argv:
        bg = Image.open(os.path.join(SRC, 'beach.jpg')).convert('RGBA')
        ov = np.zeros((*dry.shape, 4), np.uint8)
        ov[~dry] = (255, 0, 0, 90)
        Image.alpha_composite(bg, Image.fromarray(ov, 'RGBA')).save('/tmp/dry-preview.png')
        print('preview /tmp/dry-preview.png')


if __name__ == '__main__':
    main()
