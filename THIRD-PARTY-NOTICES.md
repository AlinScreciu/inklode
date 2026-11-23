# Third-party notices

The projects below are the ones Inklode owes a notice to: those it ships work derived from, and, in the last section,
those whose file formats it reads and writes without using their code. Each is listed with what Inklode uses and its licence.
The other npm and Cargo dependencies are linked, not adapted, and carry their licences in their own packages.

## Lucide

- Used for: the icons in the app's UI, through the npm package `lucide-react`, bundled unchanged.
- Source: <https://github.com/lucide-icons/lucide>. ISC License, Copyright (c) Lucide Icons and Contributors; some icons derive from Feather, MIT License, Copyright (c) 2013-present Cole Bemis. The full text is `node_modules/lucide-react/LICENSE`.

## Catppuccin

- Used for: the built-in themes `src/themes/Catppuccin.css`, `Catppuccin Frappé.css` and `Catppuccin Macchiato.css`. They are ports to Inklode's CSS variables: the colours are the Catppuccin palette, and the choice of which colour goes where follows Catppuccin for Obsidian. No rule of the original stylesheet is copied.
- Sources: <https://github.com/catppuccin/obsidian> (theme), <https://github.com/catppuccin/palette> (palette). Both carry the licence below.

```
MIT License

Copyright (c) 2021 Catppuccin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Minimal Theme for Obsidian

- Used for: the built-in theme `src/themes/Minimal.css`, a port to Inklode's CSS variables of Minimal's default colour scheme and type sizes. No rule of the original stylesheet is copied.
- Source: <https://github.com/kepano/obsidian-minimal>

```
MIT License

Copyright (c) 2020-2024 Steph Ango (@kepano)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Things

- Used for: the built-in theme `src/themes/Things.css`, a port to Inklode's CSS variables of the Things theme's colours, type sizes and a few of its traits (coloured headings, pink bold and italic, green quotes). No rule of the original stylesheet is copied.
- Source: <https://github.com/colineckert/obsidian-things>, by Colin Eckert (@colineckert). Its LICENSE file carries the copyright line below.

```
MIT License

Copyright (c) 2020-2021 Stephan Ango (@kepano)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## File formats read and written

The projects in this section are not shipped and nothing in Inklode is derived from their code. Inklode reads and
writes files in their formats, so that the same files work in both.

### Obsidian Excalidraw plugin

- Used for: nothing of its code. Inklode reads and writes the plugin's drawing files (`<name>.excalidraw.md`, uncompressed) and the slideshow data its Slideshow script keeps on a frame (`customData.slideshow`: slide order, exclusion, presenter notes, deck name, build steps). No code from the plugin or its scripts is included. The slideshow format and the behaviour Inklode implements for it are described in `docs/slideshow-spec.md`, and the implementation is written from that document.
- Source: <https://github.com/zsviczian/obsidian-excalidraw-plugin>. AGPL-3.0, by Zsolt Viczian (zsviczian).
