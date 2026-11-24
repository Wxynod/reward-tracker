"""端黑宋 Condensed 切片：fonttools + brotli。源字体见 ChillDuanHeiSong v1.2 release 的 ChillDuanHeiSong_v1.2.zip。"""
import re, sys, os, json
from concurrent.futures import ProcessPoolExecutor
from fontTools.ttLib import TTFont
from fontTools import subset

css = open(sys.argv[1], encoding='utf-8').read()
blocks = re.findall(r"noto-serif-sc-\[(\d+)\]-400-normal \*/.*?unicode-range:\s*([^;]+);", css, re.S)
def parse(r):
    s = set()
    for part in r.split(','):
        part = part.strip().upper().replace('U+', '')
        if '-' in part:
            a, b = part.split('-'); s.update(range(int(a, 16), int(b, 16) + 1))
        else:
            s.add(int(part, 16))
    return s
SLICES = [(int(i), parse(r)) for i, r in blocks]

def job(args):
    src, outdir, idx, cps = args
    f = TTFont(src)
    have = set(f.getBestCmap()) & cps
    if not have: return None
    opts = subset.Options(); opts.flavor = 'woff2'; opts.hinting = False
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]; opts.layout_features = ['*']; opts.notdef_outline = True
    s = subset.Subsetter(opts); s.populate(unicodes=have); s.subset(f)
    path = f"{outdir}/{idx}.woff2"; subset.save_font(f, path, opts)
    # unicode-range written from the codepoints actually present
    cs = sorted(have); rngs = []; a = b = cs[0]
    for c in cs[1:]:
        if c == b + 1: b = c
        else: rngs.append((a, b)); a = b = c
    rngs.append((a, b))
    return idx, ','.join(f"U+{a:x}" if a == b else f"U+{a:x}-{b:x}" for a, b in rngs), os.path.getsize(path)

HEAD = '''/* 寒蝉端黑宋 Condensed（ChillDuanHeiSong v1.2，SIL OFL 1.1，https://github.com/Warren2060/ChillDuanHeiSong）
   按 Noto Serif SC 的切片方式拆成 woff2，浏览器只下载页面用到的分片。
   Condensed Regular = 400；Condensed Medium = 500–900。由 scripts/build_cdhs_font.py 生成，不要手改。 */'''

if __name__ == '__main__':
    # 用法：python build_cdhs_font.py <@fontsource/noto-serif-sc 的 400.css> <CondensedRegular.otf> <CondensedMedium.otf> <front/fonts>
    _, reg, med, root = sys.argv[1:5]
    lines = [HEAD]
    for src, w, rng in ((reg, '400', '400'), (med, '500', '500 900')):
        outdir = f"{root}/cdhs-c-v12/{w}"; os.makedirs(outdir, exist_ok=True)
        with ProcessPoolExecutor() as ex:
            res = sorted(r for r in ex.map(job, [(src, outdir, i, c) for i, c in SLICES]) if r)
        print(w, len(res), 'slices', sum(r[2] for r in res) // 1024, 'KB')
        for i, r, _ in res:
            lines.append(f'@font-face{{font-family:"RT Display CJK";font-style:normal;font-weight:{rng};font-display:swap;src:url(cdhs-c-v12/{w}/{i}.woff2) format("woff2");unicode-range:{r}}}')
    open(f"{root}/cdhs.css", 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
