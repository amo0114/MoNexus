# MoNexus Brand Concepts — gpt-image-2 Exploration

These are four raster brand-mark candidates generated with `gpt-image-2`, then
prepared as transparent PNG and favicon assets against the three live theme
tokens. They are exploration assets only: after a direction is chosen, redraw
the selected silhouette as the canonical single-colour inline SVG in
`src/components/ui/Logo.tsx`.

| Candidate | Story | Design read | Recommendation |
| --- | --- | --- | --- |
| A — Crosspoint | Three routes meet at an open diamond hub. | Angular weave with forward movement. | **Recommended**: most explicitly says “Nexus”. |
| B — Tri-lattice | Three parties lock around a central opening. | Strong crypto-forward lattice. | Exploratory; its triangular silhouette is intentionally bolder. |
| C — Grid Knot | Three square brackets bind an off-centre aperture. | Secure, engineered connection. | **Recommended** for the most recognisable small icon. |
| D — Relay Gate | Three actors converge at a small shared gap. | The cleanest, most minimal junction. | Best 16px fallback, but less distinctive than A or C. |

Every candidate directory contains:

- `preview-three-themes.png` — actual light, dark, and soft theme backgrounds.
- `preview-favicon-16px.png` — 16px browser-tab proof, enlarged with nearest-neighbour pixels.
- `mark-light.png`, `mark-dark.png`, `mark-soft.png` — 512px transparent marks.
- `favicon-<theme>.ico`, plus 16px, 32px, and 180px transparent PNG variants.
- `mark-mask.png` — a colour-independent alpha mask useful for final SVG tracing.

Theme colours applied in the previews:

- Light: `#6366F1` on `#F8FAFC`
- Dark: `#818CF8` on `#0A0A14`
- Soft: `#FF8C42` on `#FFF8EC`
