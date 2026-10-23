# assets

Images that are not part of the running plugin — the repository's own presentation.

| File | Size | Where it goes |
|---|---|---|
| `avatar-512.png` | 512×512 | the repository's avatar, uploaded by hand in **Settings → General → Repository image** |
| `social-preview-1280x640.png` | 1280×640 | the link preview card, uploaded by hand in **Settings → General → Social preview** |
| `social-preview.svg` | source | the card before rendering: the icon centred on the `#101828` canvas at 1280×640 |

Both are rendered from [`../../packages/core/icon.svg`](../../packages/core/icon.svg), which is the
icon the plugin ships and the one the README draws. GitHub accepts only raster images for those two
slots, and offers no API for either — so they are uploaded once, by a person, and they do not follow
the SVG afterwards.

Re-render after changing `icon.svg`, with any SVG renderer:

```
rsvg-convert -w 512 -h 512 ../../packages/core/icon.svg -o avatar-512.png
rsvg-convert -w 1280 -h 640 social-preview.svg -o social-preview-1280x640.png
```

The social card is not the icon alone: `social-preview.svg` places it on a `#101828` canvas at the
16:8 ratio the preview slot expects, at the size a card is read at — scaling the square avatar up
instead leaves a small mark in a large field.