# MoNexus Logo Design Brief

> Purpose: hand this document to a logo / brand-mark designer (human or AI agent).
> Last UI iteration: 2026-05-11. Two in-house attempts ("indigo-gradient block + letter M"
> and "3-node triangle topology") were rejected — both for being either too generic
> SaaS / AI-tool template, or too simplistic.

---

## 1. Project at a glance

- **Name:** MoNexus
- **Business:** Points-based digital-goods marketplace. Users earn points by completing
  tasks (daily check-in, invites, etc.) and redeem points for digital resources —
  premium accounts, gift cards, invite codes, course downloads, network nodes, etc.
- **Actors:** End consumers, merchants (third-party sellers), platform admins.
- **Stage:** Re-skinning a production-ready application; the codebase is real, the
  brand is being firmed up alongside it.

## 2. Name semantics — the storytelling hook

- **"Mo"** — short prefix carried over from the previous identity (was "MoYuan"). No
  fixed meaning required; treat as a brand-side syllable that gives rhythm.
- **"Nexus"** — Latin for *connection, binding point, hub*. In English this is the
  word people reach for when they describe a network's center, a meeting point, or
  a knot of relationships.

A successful mark should make a viewer go *"oh — Nexus, of course"* once they hear
the name. The visual should sit on top of one of these concepts:

- A **hub** with spokes (one center, several arms).
- A **knot** or **weave** (lines crossing through a binding point).
- A **lattice / mesh** (a regular grid of nodes, indicating a network at scale).
- A **trade flow** (arrows / paths converging — fits the marketplace business).
- **Multiple parties meeting** (three-way handshake of user / merchant / platform).

The mark should feel like the *answer* to "what does Nexus look like," not a
generic geometry.

## 3. Tone & design language

### Required mood

- `crypto / web3 / futuristic / tech / digital`
- `block-based / vibrant / high-contrast / geometric`
- Engineered, deliberate, sharp. Not playful, not friendly-blob.

### Required visual properties

- **Single-color**, ideally rendering correctly via SVG `currentColor`.
- **Sharp geometry only**: straight lines, right angles, or precise polygons.
- **Original**: must not be reducible to "rounded square + a letter" or "rings + a
  dot" or any other SaaS-template silhouette.
- **Legible at 16 px** (favicon size). If it falls apart at favicon size, it's
  not the right mark.
- **Distinct silhouette**: a viewer should be able to recognize it from its
  outline alone, with no color or fill.

### Hard "do not" list

- ❌ Gradient-filled rounded square containing a single letter (Cursor / Lovable
  / many AI tools default). This is the explicit reason the previous attempt was
  rejected.
- ❌ Apple-style soft glow (`drop-shadow blur`), inner shadow gloss, frosted
  highlights.
- ❌ Soft curves / pillowed shapes / hand-drawn vibe.
- ❌ Pictograms of physical objects (houses, shopping bags, stars).
- ❌ Emoji or icon-from-icon-pack repurposed as the mark.
- ❌ Generic six-pointed star, planet-with-ring, infinity loop, swooshes —
  overused crypto and SaaS clichés.
- ❌ Lettermark that is literally the letter "M" inside a shape.

## 4. Technical spec

| Property | Value |
|---|---|
| Format | SVG (inline, single file, no external assets) |
| Color | Single color via `currentColor`, or one fixed indigo |
| Viewbox | `0 0 N N` square. Recommended N = 36 or 48. |
| Stroke | If lines are used, target stroke-width ≈ 2-3 px in a 36px viewbox |
| Sizes that must work | 16 (favicon), 24 (nav-mini), 32 (nav), 80 (login wordmark), 192 (OG image) |
| Animation | Optional but desirable: a single subtle entrance animation suitable for `prefers-reduced-motion: no-preference`. Static must be the canonical state. |

### Color tokens (for reference, not for hard-coding into the SVG)

```
Light mode:  --color-primary       #6366F1   (indigo-500)
             --color-primary-hover #4F46E5   (indigo-600)
Dark mode:   --color-primary       #818CF8   (indigo-400)
             --color-primary-hover #A5B4FC   (indigo-300)
```

Prefer `currentColor` so the same SVG works in both modes by inheritance.

### Typography that the mark must coexist with

- Headings, including the wordmark: **Orbitron** 400 – 700.
- The wordmark renders as `MONEXUS` in all-caps with `letter-spacing: 0.18em`.
- The mark should sit visually next to that wordmark without competing with it
  (i.e., the mark's optical weight should roughly match the cap height of the
  wordmark).

## 5. Deliverables

Prefer producing **3 distinct concept directions**, each as a separate SVG, so we
can pick the strongest one. For each concept include:

1. **Concept name** (one or two words) and a one-sentence rationale linking it
   to the Nexus storytelling hook from §2.
2. **Mark SVG** at 36×36 viewbox (canonical size).
3. **Mark + wordmark lockup** showing the mark next to `MONEXUS` at nav
   proportions (mark ≈ 32 px, wordmark ≈ 18 px font-size).
4. A **favicon-sized rendering** (16×16) proving the mark survives small sizes.
5. **Light-mode and dark-mode samples** on the project's actual background
   tokens (`#F8FAFC` light, `#0A0A14` dark).

## 6. Reference vocabulary

These are not styles to copy, only a vocabulary of what *good* looks like in
this neighborhood. Use them to calibrate; do not imitate.

- **Vercel** — single triangle, no fill variation, sits perfectly at 16 px.
- **Linear** — a precise, asymmetric geometric mark that ties to the
  "straight-line / fast-flow" name.
- **Stripe** — three horizontal bars at different lengths with a gradient
  implication — the mark *is* the product (a stripe).
- **Notion** — single character on a block, but the character is treated like
  brutalist printmaking, not a logo template.
- **Polygon / Arbitrum / Optimism** — node-and-edge crypto motifs done with
  taste.

Anti-references (please do not deliver something that looks like any of these
have been input to a generator):

- Default Lovable / v0 / Bolt-style logos.
- Round-cornered-square-with-initial template.
- "Spinning Saturn" planetary marks.
- DALL·E-flavored 3D rendered crystal balls.

## 7. Application screens (so the mark gets evaluated in context)

Once the candidate marks exist, evaluate each on these surfaces:

1. **Top-left of the global nav bar** (sticky, glass-backdrop, on `#F8FAFC` light
   and `#0A0A14` dark). Mark sits at ≈ 32 px, wordmark to its right.
2. **Login page hero**, where the mark + wordmark stack at ≈ 80 px mark size.
3. **Footer**, at 20 px next to the wordmark.
4. **Favicon** in a browser tab on a busy tab strip.
5. **Loading skeleton** — confirm the mark reads as a brand cue when fully
   reduced.

The winning concept is the one that holds up *worst at favicon size, best at
hero size, and never looks like it came out of a template generator.*

## 8. Anti-success signals — call them out

If during exploration the concept starts to drift into any of these, stop and
restart:

- Looks like the Cursor / Lovable / v0 default.
- Could be a different company's logo by changing one letter in the wordmark.
- Cannot be drawn from memory by the designer after one minute away from the
  reference.
- Needs more than 5 nodes / shapes / lines — it is too busy.
- Is recognizable only when the wordmark is next to it.

---

*The graphic brand-mark slot in `src/components/Layout.tsx` is currently empty
on purpose (Orbitron wordmark only). Drop the chosen SVG into a new
`src/components/ui/Logo.tsx` component and reintroduce it next to the wordmark;
the surrounding layout already reserves visual space and keeps the wordmark
balanced with or without a mark.*
