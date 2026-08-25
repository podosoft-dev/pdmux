# Where these icons came from

| | |
|---|---|
| Upstream | https://github.com/vscode-icons/vscode-icons |
| Tag | **v12.19.0** (released 2026-06-27) |
| Fetched | 2026-08-19 |
| Icons at that tag | 1553 — the 62 below are the ones this product draws |
| Licence | icons CC BY-SA 4.0, branded icons under their owners' terms — see `LICENSE` |

Each file was fetched from
`https://raw.githubusercontent.com/vscode-icons/vscode-icons/v12.19.0/icons/<name>.svg`
and written here **unchanged**. The digests below are what makes "unchanged"
checkable; they are also how a refresh tells you what actually moved rather than
re-reviewing 62 files.

## Refreshing

```sh
tag=v12.19.0                                  # bump this
for f in *.svg; do
  curl -sSfL "https://raw.githubusercontent.com/vscode-icons/vscode-icons/$tag/icons/$f" -o "$f"
done
shasum -a 256 *.svg                           # compare against the table below
```

Then rebuild the string module the components import — the icons are not read
from disk at runtime:

```sh
bun tools/build-file-icons.mjs                # writes ../file-icons.gen.ts
```

## Why these 62

- **4 structural**: `default_file`, `default_folder`, `default_folder_opened`,
  `default_root_folder`.
- **9 category fallbacks** for the roles `@pdmux/core`'s `fileKindOf()` returns,
  so an unknown extension still gets something better than a blank.
- **the rest are per-language and per-tool marks**, which is the point: a listing
  is scanned, and a logo is recognised faster than a word is read.
- **9 `file_type_light_*` twins.** Upstream ships these for light themes and the
  reason is measurable: `file_type_yaml`'s only colour is `#ffe885`, luminance
  0.90, which is invisible on a light card, while `file_type_light_yaml` measures
  0.76. The component takes a `scheme` prop rather than guessing — see
  `FileIcon.svelte`.

## Why some obvious names are absent

⚠ **Size is the selection rule, because these are shipped as strings in a
published package.** Four upstream icons are enormous for what they say, so a
smaller sibling or a category fallback is used instead:

| Wanted | Upstream bytes | Used instead |
|---|---|---|
| `file_type_pdf` | 42,560 | `file_type_pdf2` (3,600) |
| `file_type_license` | 24,274 | the `doc` fallback, `file_type_text` |
| `file_type_key` | 18,247 | `file_type_config` |
| `file_type_perl` | 6,293 | `file_type_perl2` (2,343) |

⚠ **Minifying them is not an option** — see `LICENSE`. Selection is the only
lever, which is why this table exists rather than a build flag.

Upstream has no icon for `Makefile`, `*.lock` or `*.csv` (checked at v12.19.0),
so those map to `file_type_config`, `file_type_config` and `file_type_text`.

## Digests

```
06d28856c58270cc05c7885ea6bc6b3b15855e75eeeded56372af08e82a4ad5b  default_file.svg
2769a1a98b586599268d6464892ecbcf1b6aaaa3b0fd238f0a2b2b79d699ce8f  default_folder.svg
28d02bc12111a848a333594b6e31476172cc42943c82b2c262df822a81178f69  default_folder_opened.svg
1f5937b696b76ba4c54dc0db8e645eb3efdaaaefe6347880f861b6d936c2676f  default_root_folder.svg
cdf7cea276b5c2cf3cdeb919a22c928a63390bfdcf4451a54046ee1193abb5db  file_type_audio.svg
3480ded49729a9c2acd66fccbaae710817417299c3b23dfeef9a9c3bf245e849  file_type_binary.svg
5eeaa3d6b7c97f0ee882db28dcc5152ee28ef8e840de44684c36a1838a363848  file_type_c.svg
789e40a179398f81b944f330e5da08e1562cbf1f037417c62441ba3174407c96  file_type_config.svg
9177dcd31db0cea77352d4cea482d125c2906cbffdc446e1a8adf5541d8228b8  file_type_cpp.svg
7f6b1a627927408fd5047ece4bc5527a5cc04c03b0e9c610f732e39a2c7f9a4b  file_type_csharp.svg
60770fec4356ea426c1757d2563f055861188bf3f2d3417652484ed5d633df2a  file_type_css.svg
8d19e1a20124f9ace8b8055aa00144de7c5e58977274a368b18fa2be67290753  file_type_docker.svg
3a424149b2fe7137df2ed15c7488257ddf78b70636cc1c482d5c536357aa6c3f  file_type_dotenv.svg
1e34c2c5c4df5039f65ac699d8d3558e0ef6192ee8a849166581fc027b72570c  file_type_font.svg
273a5c8719145b01e0e490629459b0c79b4a07b67220cb2bcec2c0f0f7feaf73  file_type_git.svg
e57833fdb01c3d907a0f0fe1562145c3a49fa067c6a553474205ef0ec9f3abd8  file_type_go.svg
831b0a8ab1ca3ac0032d6f3ca57026725f16a9f360e898130c7289fa61dc161f  file_type_html.svg
5c893f16ace217a90a646fe8c590a9331e3a165e492ef1a7e14ce701eb9a9b59  file_type_image.svg
11cec1bc5f43d033bfa15bb60cb95204647528f1bc1514225666091e03b4df99  file_type_ini.svg
6883a1fd2c8907f9c2368b8b411cdd73646391d65471ec1d087c723499b92bd9  file_type_java.svg
d68f37e152eda0ce5350de6bd21ce7e4a31c7b80487396dd2a4bf6767903fc8d  file_type_js.svg
89efce449a8e2d6224cd0984263ab7c5bf518b9bedaee3267a3049e320389652  file_type_json.svg
6f10e38fa7866a53d4e7ea62474855a7cbc19d26a796f0ed275127e8123445c6  file_type_kotlin.svg
da286660dea11d3f09de6d160fdfc7437e5ebbb8aac3ae7912eddbc5a29b859a  file_type_light_config.svg
a9603a161c2bff516d644b840697d579781d708936d466b59fbd5d9c63fdd008  file_type_light_font.svg
cf5dcf49e053e7e01082096ebd6d9c47dce630beda106c410465107fcca7fd60  file_type_light_ini.svg
bab3f23372abacf5e445f690002609a9f0c788e84922e8abf99ba1572b78afba  file_type_light_js.svg
4715b67680b95e5a3e1c5b40bc1977772f4dd1c9a35812d03061c7437e2c6253  file_type_light_json.svg
bf4d29b42975058f78340f213995f1aa2e413cb099f2cf9fe2dd2a9c2e008d23  file_type_light_pnpm.svg
c4fec77f64e232c4c74afbf66d4076d9cd45ec0a0002b7ef769ed42ef8d58a45  file_type_light_rust.svg
8e2b1051c5f403e103f48b28de9bd2c76149b4382291f27c2d7058ed87726360  file_type_light_toml.svg
85b2966bbb04ff017d2635e5ed2f2124eea7bd5e43ee99f0a2d1ac3b410a7144  file_type_light_yaml.svg
33a0fa03488382e955f7b83d8d0183897452ac5a775bc4fadbdbe7e6c17a7d64  file_type_log.svg
1e0db95b1fdd4a88382a2bc1fdc55ae263ee7fb8a9d3234bcfa64067e60e1ece  file_type_lua.svg
fa10b34b3c72cc10ac1c6f7013c366e76b310fa3efab1635b1e382bc6d6f9530  file_type_markdown.svg
20a3ec1782ecf5de819d3bacbf03163a96fb9f1261562fbcb906091f8b0fee3a  file_type_nginx.svg
ed62774c5d922bad05dd8bb9f0d2f0cf78e29fc92fbf04520c582901ddfb43ba  file_type_npm.svg
e429fcec8a053d2dc1d4f459190ee28c0a9306be9c1fff057af81a814ccb70f0  file_type_pdf2.svg
b2189c315efaabd336d7e882b96200b399536ad3681a0e076e6f5ac06a1480c8  file_type_perl2.svg
084bdb387b71d02c33a94e101b609c9992450f5cc964ba6faf0721aeec038fb1  file_type_php.svg
bea8b556e93ef9e4e94d5f4fa7183a45d7a69e3b552ba1765b756b1a6c9a1c8b  file_type_pnpm.svg
6ff4984f20c2edb883042275c9316cfc499937b7846ab0daea8e1f94f185417a  file_type_python.svg
535b1b8579129cd44597e7888d2e5bb6141995f7b4717b7abaa907ce1f8866db  file_type_reactjs.svg
7fe69153e20ef4e0656e4852e59dbc9a1bcb001d0fe679c13091b8d9430f7447  file_type_reactts.svg
30fb5a074f1b9b9c3066db836df8ca9917cddd6ff255902c4780eb60d32af3d7  file_type_ruby.svg
e3b757d00621b208470a24894170f2798c7014d24452c4c0b81625c5e00dfe09  file_type_rust.svg
34d60b741aea31a0df4cd330c29fc68d9dae21e8228921643d48cd16f0030d04  file_type_scss.svg
d163b782ad9a6e8a1ce59a1768cf8660f14b259a960d7532b406966826cef165  file_type_shell.svg
62b0eaabf2856133bf75e990f39cea16f502770e6058374e1edf2a75dde2d0db  file_type_sql.svg
c027e8621f2d5a8d03b33cf6f60d197c398a0ced022cc180a40c5fc60be3cd2b  file_type_svelte.svg
e6a8891c70dd3d41a04241179bbb0989cf5be1652b9b22cb0c9ed593a8df0952  file_type_swift.svg
406d6b8654888a9bdf35428f57cac28a5b4ab41d5f7fc69592a3fc06574e2c56  file_type_terraform.svg
2d4d4b3039b6b85ab7ea34580cb4bd861dc0f24cf040d44449251d20960be790  file_type_text.svg
54af3f2d60a54a8a9d121c727a94827710790bb3a14ca599dbb1cb6f59d4cf94  file_type_toml.svg
5ebd14bd43aea8116a932d99b0d41ecc3f63cdbc0bda9a58bd0eb08a00129020  file_type_typescript.svg
149808be9823d79b923c65bfde81831c42278c3a4214d9d0849d6cf6bfdae508  file_type_typescriptdef.svg
3e9211489debc391e2672c129929785960f25ea21e2e2e398acca56a3efaf6f2  file_type_video.svg
00a343b88a4f754e2724d4b7dcca1506140b5963ffe36eee9f7c8a924d4664b7  file_type_vue.svg
df7248047bf4faa5a22bceca27e34d7a40cec1e84c611fa2ebefe54af05e85b8  file_type_xml.svg
312b2f1c58eeaf8615db76c6d84e5dc705c8943a1c67657046f70c3147f836c2  file_type_yaml.svg
611fae654275208650cf593439c120c4b43688d78276197a79591ceea680baeb  file_type_yarn.svg
9f172503d7d7e9d3f08b0045e446af3d97bbff783fbe7224db72f4ee186d35f8  file_type_zip.svg
```
