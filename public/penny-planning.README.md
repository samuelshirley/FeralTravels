# Penny planning loader assets

`PennyPlanningLoader` (`src/components/PennyPlanningLoader.tsx`) expects two
assets in this `public/` folder. Until they ship, the loader degrades to copy +
3-dots (a missing video falls back to the poster, a missing poster to copy).

- **`penny-planning.mp4`** — ~30s clip of the dogs playing fetch. Keep it small
  and compressed (target well under ~2 MB so it doesn't hurt mobile load).
  Muted, plays inline, autoplays, loops. 16:9 renders best with the current CSS.
- **`penny-planning.jpg`** — poster frame for fast first paint and the
  reduced-motion / autoplay-blocked fallback. Same aspect ratio as the video.

Drop the files in here with these exact names and the loader picks them up — no
code change needed.
