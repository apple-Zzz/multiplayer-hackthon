#!/usr/bin/env python3
"""Slice assets/source/cutouts.jpg into transparent rig parts + public/rig/rig.json.

The sheet has three rows (A top, B middle, C bottom) on a pure-black background.
Each part has a dark-gray outline (luma ~17-28), so a low threshold separates
parts from the background without eating outlines. Every row holds 15 parts:

  reference | head | torso | upper arm x2 | forearm x2 | thigh x2 | lower leg x2 | mouths (3, stacked) | prop

Joint pivots/sockets are fractions of each part's own image box and are the
single source of truth for both the browser renderer and the preview script.

  python3 stage/slice-rig.py            write parts + rig.json
  python3 stage/slice-rig.py --preview  also write /tmp/rig-preview.png (rest pose vs reference)
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SHEET = os.path.join(ROOT, 'assets', 'source', 'cutouts.jpg')
OUT = os.path.join(ROOT, 'public', 'rig')
ROWS = ['A', 'B', 'C']

# Pivot = the point a part rotates around and attaches by (fraction of its own w,h).
# Sockets = where children attach on the parent (fraction of the parent's w,h).
JOINTS = {
    'torso': {'sockets': {'neck': [0.5, 0.07], 'shoulder_l': [0.10, 0.18], 'shoulder_r': [0.90, 0.18],
                          'hip_l': [0.30, 0.86], 'hip_r': [0.70, 0.86]}},
    'head': {'pivot': [0.5, 0.94], 'sockets': {'mouth': [0.5, 0.75]}},
    'upper_arm': {'pivot': [0.5, 0.13], 'sockets': {'elbow': [0.5, 0.86]}},
    'forearm': {'pivot': [0.5, 0.08], 'sockets': {'hand': [0.5, 0.88]}},
    'thigh': {'pivot': [0.5, 0.12], 'sockets': {'knee': [0.5, 0.86]}},
    'lower_leg': {'pivot': [0.5, 0.07], 'sockets': {'foot': [0.5, 0.99]}},
    'mouth': {'pivot': [0.5, 0.5]},
    'prop': {'pivot': [0.5, 0.06]},
}


def segment(img):
    luma = img.max(2)
    mask = ndi.binary_closing(luma > 12, iterations=2)
    mask = ndi.binary_fill_holes(mask)
    lab, _ = ndi.label(mask)
    parts = []
    for i, sl in enumerate(ndi.find_objects(lab)):
        comp = lab[sl] == i + 1
        if comp.sum() < 25:
            continue
        parts.append({'y0': sl[0].start, 'y1': sl[0].stop, 'x0': sl[1].start, 'x1': sl[1].stop, 'mask': comp})
    return parts


def cut(img, p, pad=2):
    """Crop one part with its own mask as alpha (feathered by a fraction of a pixel)."""
    h, w = p['y1'] - p['y0'], p['x1'] - p['x0']
    rgba = np.zeros((h + 2 * pad, w + 2 * pad, 4), np.uint8)
    rgba[pad:pad + h, pad:pad + w, :3] = img[p['y0']:p['y1'], p['x0']:p['x1']]
    alpha = Image.fromarray((p['mask'] * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    rgba[pad:pad + h, pad:pad + w, 3] = np.asarray(alpha)
    return Image.fromarray(rgba, 'RGBA')


def main():
    img = np.asarray(Image.open(SHEET).convert('RGB'))
    parts = segment(img)
    row_h = img.shape[0] / 3
    rig = {'joints': JOINTS, 'characters': {}}
    for r, who in enumerate(ROWS):
        row = sorted([p for p in parts if r * row_h <= (p['y0'] + p['y1']) / 2 < (r + 1) * row_h], key=lambda p: p['x0'])
        assert len(row) == 15, f'row {who}: expected 15 parts, found {len(row)}'
        ref, head, torso, ua1, ua2, fa1, fa2, th1, th2, ll1, ll2 = row[:11]
        mouths = sorted(row[11:14], key=lambda p: p['y0'])  # closed, slightly open, wide open (top → bottom)
        prop = row[14]
        named = {'reference': ref, 'head': head, 'torso': torso,
                 'upper_arm_l': ua1, 'upper_arm_r': ua2, 'forearm_l': fa1, 'forearm_r': fa2,
                 'thigh_l': th1, 'thigh_r': th2, 'lower_leg_l': ll1, 'lower_leg_r': ll2,
                 'mouth_closed': mouths[0], 'mouth_open': mouths[1], 'mouth_wide': mouths[2], 'prop': prop}
        os.makedirs(os.path.join(OUT, who), exist_ok=True)
        entry = {}
        for name, p in named.items():
            im = cut(img, p)
            im.save(os.path.join(OUT, who, f'{name}.png'))
            entry[name] = {'src': f'/rig/{who}/{name}.png', 'w': im.width, 'h': im.height}
        rig['characters'][who] = entry
    with open(os.path.join(OUT, 'rig.json'), 'w') as f:
        json.dump(rig, f, indent=2)
    print(f'Wrote {OUT}/rig.json and {len(ROWS) * 15} part images')
    if '--preview' in sys.argv:
        preview(rig)


# ---------- rest-pose preview (same attachment math as src/rig.ts) ----------
def kind(name):
    return 'mouth' if name.startswith('mouth') else name.rsplit('_', 1)[0] if name[-2:] in ('_l', '_r') else name


def place(canvas, rig, who, part, parent_xy, angle_deg, scale, origin):
    info = rig['characters'][who][part]
    pv = rig['joints'][kind(part)]['pivot']
    im = Image.open(os.path.join(ROOT, 'public', info['src'].lstrip('/'))).convert('RGBA')
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    px, py = pv[0] * im.width, pv[1] * im.height
    x, y = origin[0] + parent_xy[0] - px, origin[1] + parent_xy[1] - py
    canvas.alpha_composite(im, (int(round(x)), int(round(y))))


def sock(rig, who, part, s, scale, top_left):
    info = rig['characters'][who][part]
    f = rig['joints'][kind(part)]['sockets'][s]
    return (top_left[0] + f[0] * info['w'] * scale, top_left[1] + f[1] * info['h'] * scale)


def preview(rig):
    scale = 0.9
    W = 3 * 560
    canvas = Image.new("RGBA", (W, 620), (240, 200, 120, 255))
    for i, who in enumerate(ROWS):
        c = rig['characters'][who]
        tw, th = c['torso']['w'] * scale, c['torso']['h'] * scale
        origin = (i * 560 + 330, 140)
        torso_tl = (-tw / 2, 0)
        def tl_of(part, parent_xy):
            pv = rig['joints'][kind(part)]['pivot']
            return (parent_xy[0] - pv[0] * c[part]['w'] * scale, parent_xy[1] - pv[1] * c[part]['h'] * scale)
        # legs (lower leg under thigh), torso, arms (forearm under upper arm), head, mouth
        layers = []
        for side in 'lr':
            hip = sock(rig, who, 'torso', f'hip_{side}', scale, torso_tl)
            knee = sock(rig, who, f'thigh_{side}', 'knee', scale, tl_of(f'thigh_{side}', hip))
            layers += [(0, f'lower_leg_{side}', knee), (1, f'thigh_{side}', hip)]
            sh = sock(rig, who, 'torso', f'shoulder_{side}', scale, torso_tl)
            el = sock(rig, who, f'upper_arm_{side}', 'elbow', scale, tl_of(f'upper_arm_{side}', sh))
            layers += [(3, f'forearm_{side}', el), (4, f'upper_arm_{side}', sh)]
        neck = sock(rig, who, 'torso', 'neck', scale, torso_tl)
        mouth = sock(rig, who, 'head', 'mouth', scale, tl_of('head', neck))
        layers += [(5, 'head', neck), (6, 'mouth_closed', mouth)]
        for z, part, xy in sorted(layers, key=lambda l: l[0]):
            if z == 3:
                pass
            place(canvas, rig, who, part, xy, 0, scale, origin)
            if z == 1 and part.endswith('_r'):
                canvas.alpha_composite(Image.open(os.path.join(OUT, who, 'torso.png')).convert('RGBA').resize((int(tw), int(th)), Image.LANCZOS), (int(origin[0] - tw / 2), int(origin[1])))
        ref = Image.open(os.path.join(OUT, who, 'reference.png')).convert('RGBA')
        ref = ref.resize((int(ref.width * 2.6), int(ref.height * 2.6)), Image.LANCZOS)
        canvas.alpha_composite(ref, (i * 560 + 10, 100))
    canvas.save('/tmp/rig-preview.png')
    print('Preview: /tmp/rig-preview.png')


if __name__ == '__main__':
    main()
