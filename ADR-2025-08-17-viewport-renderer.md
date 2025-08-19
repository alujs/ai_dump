# ADR: Viewport-Based Renderer for Infinite-Scale Maps

- Status: Accepted
- Date: 2025-08-17
- Decision Makers: Editor/Renderer owners

## Context

The current renderer sizes canvases to the full map pixel bounds and iterates every hex when drawing. With larger maps (e.g., 128×80 like Civ V Huge) and bigger hexes (≥108px height), this approach produces extremely large canvases and high fill costs, leading to memory pressure and jank.

We want to support effectively “infinite” map size, limited by hardware, while standardizing a viewport model so rendering work scales with what’s visible, not with total map area.

## Decision

Adopt a viewport-based renderer that:

1) Sizes canvases to the viewport (scroll container client size), not the total map pixel size.

2) Renders only the visible hexes plus a small padding buffer, derived by inverting the viewport’s pixel rect to axial hex bounds and clamping within the map.

3) Translates drawing coordinates by the viewport’s scroll offset so on-canvas positions are local to the viewport’s origin.

4) Coalesces resize/scroll/diff events via requestAnimationFrame and retains existing zero-area guards.

5) Exposes a small API to update the viewport and the hex scale, keeping the engine/grid math separate and deterministic.

This enables safe adoption of large defaults (e.g., 128×80) and larger hex sizes without memory blowups.

## Consequences

Pros:
- Render cost proportional to the viewport, not the world size.
- Memory footprint bounded by viewport area × layers.
- Clean path to very large maps and larger hex sizes.

Cons:
- Requires translation math (scroll offsets) in the adapter.
- Base layer caching is no longer a single pre-render; we either redraw per frame (cheap with culling) or add a tile cache later.
- Selection and overlays must use the same translation to stay aligned.

## Scope & Interfaces

Engine (packages/engine): No changes. RenderPackage schema remains the same.

Adapter (adapters/pixi):
- New viewport state: `{ scrollLeft, scrollTop, width, height, paddingPx }` with padding defaulting to ~1 hex height.
- New methods on the scene:
  - `updateViewport(view: { scrollLeft: number; scrollTop: number; width: number; height: number; })` — updates local origin and schedules render.
  - `setHexHeight(px: number)` — updates hex scale and schedules rebuild.
- Resize: use container clientWidth/clientHeight for canvas sizes; no longer set canvas width/height to full map bounds.
- Rendering:
  - Compute visible axial bounds using HEX.pixelToAxial on the viewport rect ± padding, clamp by mapSize.
  - Iterate only visible q,r and draw terrain, fog, tokens as before, but subtract `scrollLeft/scrollTop` from pixel centers when plotting.

Editor (apps/editor):
- Host will call `scene.updateViewport()` on scroll/resize of the stage container and `scene.setHexHeight()` when UI changes hex scale.
- Default map preset can switch to "Huge (128×80)" once the viewport path is in.
- Hex size can increase (proposal: 120px height) after verifying performance.

## Implementation Plan (Phased)

Phase 1 — Minimal viewport renderer (this ADR):
- Add viewport state + API to the adapter.
- Size canvases to viewport; render only visible hexes with padding.
- Keep rAF coalescing and zero-area guards.
- Ensure fog/phantoms and tokens use translated coordinates.
- Hook editor stage scroll/resize to `updateViewport()`.

Phase 2 — Quality and UX:
- Add a simple “Huge (128×80)” quick preset and make it the default.
- Increase hex target height to 120px (from 72px) and validate on mid-spec hardware.
- Maintain vertical/horizontal centering and drawer overlays.

Phase 3 — Performance & Caching (optional but recommended):
- Introduce terrain tile cache (offscreen canvas per chunk or stripe) to reduce background redraws.
- Batch fog and token draws by row to reduce state changes (still 2D canvas for now).

## Test/Validation

- Unit/Smoke:
  - Rendering with small viewports on large maps shows correct tiles at all scroll positions.
  - Fog and phantom outlines align with terrain at edges of the viewport.
  - Tokens at viewport boundaries render and disappear correctly when scrolled out.

- Performance:
  - On a 128×80 map at hex height 120px, verify stable FPS with viewport around 1600×900 and typical entity counts.
  - Memory: canvas allocations remain bounded to viewport size × 2–3 layers.

## Migration

- Remove direct usage of full `HEX.mapPixelBounds(width,height)` for canvas sizing; keep it only for computing world pixel sizes when needed for layout.
- Introduce scroll listeners in the editor host, feeding offsets to the adapter.
- Keep existing contracts and rules intact; no data shape changes.

## Debugging & Tools

- Add debug interface entries:
  - `DEBUG_INTERFACE.viewport()` — returns current viewport and derived visible axial bounds.
  - `DEBUG_INTERFACE.trace(hexKey)` — confirms pixel position both in world and viewport-local coordinates.

## Rollout

1) Land adapter changes with feature flag (default ON in editor).
2) Verify smoke tests and manual scroll checks.
3) Flip default map to 128×80 and hex height to 120px.
4) Monitor performance; if needed, enable Phase 3 caching.
