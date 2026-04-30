# Tool-grounded UI for Penny chat

**Status:** Sketched. Not scheduled. Sam plans to work on this in a separate session.

**Last updated:** 2026-04-30.

---

## The framing

Today Penny's chat output is a stream of LLM prose. When she plans a leg she
writes something like:

> "Day 2 will be Berlin to Prague — about 350 km, around 3.5 hours of driving.
> Your Hilux has roughly 768 km of effective range so no fuel stops needed."

Three problems with that:

1. **The prose carries facts she may have hallucinated.** Penny may say
   "350 km" when the real Google Directions number is 432 km. The user reads
   it as truth because it looks like data, not a guess.
2. **The same fact can drift between Penny's prose and the rest of the app.**
   The leg row shows 432 km because it was set by `get_route`. The chat says
   350. The user has to reconcile which is right.
3. **The shape of the answer is wrong for re-use.** Prose can't be filtered,
   sorted, edited, or pinned. A user can't tap "the Prague hotel Penny
   suggested" and have the app know which one she meant.

The fix: every fact in the chat that comes from a tool call gets rendered as
a structured card by the chat panel — not as the LLM's narration of that
fact. Penny's prose becomes connective tissue between cards ("here's the
route I found, here's the fuel plan, want me to add it?"). The cards
themselves come straight from the tool's structured output.

This is a separate concern from [`penny-tool-surface.md`](./penny-tool-surface.md).
That doc is about *which* tools to add. This doc is about *how to render
their results in the chat panel* once they exist.

---

## Why deferred

Three reasons:

1. **It's blocked on the tool-use migration finishing.** The tool-use
   migration ([`docs/proposals/tool-use-migration.md`](../proposals/tool-use-migration.md))
   was the prerequisite — Penny needs to be returning real `tool_use` /
   `tool_result` blocks before there's anything structured for the UI to
   render. That's now done for `get_route` and `split_leg_by_drive_time`,
   but the *full* tool surface from `penny-tool-surface.md` is still partial.
   Building the chat renderer against a half-populated tool set means
   refactoring it again when the rest land.

2. **It touches multiple layers at once.** Tool output schemas, chat history
   storage, the chat panel renderer, Penny's system prompt, and probably the
   replan API response shape. None of these is huge in isolation; together
   they're a multi-day project that benefits from being done in one focused
   session, not bolted on between bug fixes.

3. **The current "graceful workaround" is OK for now.** Today's chat panel
   shows Penny's prose plus the leg/route/stop rows update in the workspace
   when she calls tools. That's not the *right* end state but it's not
   actively misleading users today — Penny mostly retells facts that are
   already correct because the tools wrote them.

   It becomes urgent when Penny starts calling tools the user can't see the
   side effects of (POI search, weather, border info, fuel station search
   results that aren't all auto-applied). At that point the prose becomes
   the only window into those tool calls, and the prose lies.

---

## The end state

A chat panel where each assistant turn is a typed sequence of blocks:

```
[ prose: "Here's the route I found." ]
[ card: RouteSummary { distance_km: 432, drive_time_minutes: 285, ... } ]
[ prose: "It's tight on fuel for one tank — I'd suggest a stop near Pilsen." ]
[ card: FuelStopOption { lat, lng, name, distance_from_start_km } ]
[ prose: "Want me to add it?" ]
[ card: ConfirmAction { tool: 'add_stop', args: {...} } ]
```

Each card is a React component that knows how to render its own data. The
chat history table stores the structured blocks, not flattened prose.

Why each piece matters:

- **Cards are the source of truth for facts.** "432 km" is rendered by
  `<RouteSummary>` reading `route.distance_km` from the tool result. Penny's
  prose can describe the route but cannot insert a different number.
- **Cards are interactive.** A `<FuelStopOption>` card has Add / Skip
  buttons. The user doesn't need to type "yes add it" — they tap Add and the
  app calls the tool directly.
- **Cards are pinable / referenceable.** "Use the route from earlier" can
  be implemented because the card has a stable ID; the user can scroll back
  to it and tap "use this one."
- **Cards round-trip with full fidelity.** Reloading the trip restores the
  same cards because the chat history stored the structured data, not the
  rendered string.

---

## Rough architecture

(Sketch — verify against current code when picking this up.)

1. **Tool output schemas.** Every tool defined in `src/lib/penny/tools/`
   already has a Zod schema for its *input*. Add a Zod schema for its
   *output* — the typed shape that comes back from the API call after we
   normalize it. This becomes the contract the UI renders against.

2. **Chat history schema change.** `chatHistory.content` is currently
   `text` — a flat string. Either:

   a) Add a sibling `chatHistory.blocks` JSONB column that stores the
      typed sequence of blocks. Keep `content` for fallback / search.
   b) Switch to JSONB entirely and migrate existing rows by wrapping
      them in a single `{type: 'prose', text: ...}` block.

   Option (a) is less disruptive; option (b) is cleaner. Pick when you do
   this.

3. **Renderer dispatch.** `ChatPanel.tsx` currently renders `msg.content` as
   plain text (`src/components/ChatPanel.tsx:499`). Replace with a switch on
   block type:

   ```tsx
   {msg.blocks.map((block) => {
     switch (block.type) {
       case 'prose':         return <Prose text={block.text} />;
       case 'route':         return <RouteSummaryCard data={block.data} />;
       case 'fuel_stop':     return <FuelStopOptionCard data={block.data} />;
       case 'overnight':     return <OvernightOptionCard data={block.data} />;
       case 'confirm_action': return <ConfirmActionCard data={block.data} />;
       // ...
     }
   })}
   ```

4. **Replan API response shape.** Currently returns `{ response: string,
   changes: [...] }`. New shape: `{ blocks: Block[] }` where blocks include
   prose AND tool-use cards interleaved in the order Penny emitted them.

5. **System prompt update.** Penny stops paraphrasing tool outputs in prose
   ("the route is 432 km"). Instead her prose connects cards
   ("here's the route, here's the fuel plan, OK to add?"). This is a
   significant prompt rewrite — much of the current prompt teaches her
   *how to describe* facts; the new prompt teaches her to *defer to the
   card* and only narrate intent.

---

## Card library — first batch

In rough priority order, matching the tools from `penny-tool-surface.md`:

| Card | Backing tool | Shows |
| --- | --- | --- |
| `<RouteSummaryCard>` | `get_route` | distance, drive time, polyline preview, warnings (toll/ferry/border) |
| `<FuelStopOptionCard>` | `search_fuel_stations` | station name, brand, distance into leg, Add/Skip |
| `<OvernightOptionCard>` | `search_overnight_stops` | name, type (campsite/wild/paid), coords, Add/Skip |
| `<WeatherCard>` | `get_weather` | forecast for the leg's date, precipitation, temp range |
| `<POICard>` | `search_pois` | generic place card with name, type, distance |
| `<ConfirmActionCard>` | any mutating tool | "Add this leg?" / "Replace fuel plan?" + tool args summary + Confirm/Cancel |
| `<BorderInfoCard>` | `get_border_crossing_info` | docs needed, hours, country pair |

A few of these (`RouteSummaryCard`, `OvernightOptionCard`) overlap with
existing UI in the workspace. The chat-panel version should be a more
compact, link-out variant, not a full duplicate.

---

## What goes wrong if we do this badly

- **Card component sprawl.** Twelve tools × three card variants each = 36
  components nobody maintains. Mitigation: one card per tool, no variants.
  If it doesn't fit one card, the tool's output shape is wrong, not the
  UI's.
- **Penny still narrates the data.** The prompt change is the hard part.
  We need her to say "Here's what I found" and let the card carry the
  numbers — not "Here's a 432 km route" with the card showing 432 km
  underneath. Both is worse than either; it doubles up and confuses.
- **Chat history reload looks broken.** If we change the storage shape and
  forget to migrate, every old chat reloads as empty / corrupted. Migration
  needs to be careful and reversible.
- **Tool output schemas drift from card props.** Mitigation: the card prop
  type IS the tool output schema (`type RouteSummaryCardProps =
  z.infer<typeof getRouteOutputSchema>`). Same Zod, no second source of
  truth.

---

## Resumption checklist

When picking this up in a separate session:

1. **Confirm tool surface coverage first.** If half the tools from
   `penny-tool-surface.md` are still missing, building this against a
   half-populated set means doing it again. Either complete the tool
   surface first OR scope the UI work to only the tools that exist.

2. **Pick storage shape.** JSONB sibling column vs. full migration. Sam's
   gut: JSONB sibling so we have a fallback. Confirm against current
   `chatHistory` size and migration appetite.

3. **Define output schemas for every tool.** Add a Zod output schema next
   to each existing input schema in `src/lib/penny/tools/`. Don't ship the
   UI piece until this is done — the schema is the UI's contract.

4. **Build one card end-to-end as a vertical slice.** Pick `<RouteSummaryCard>`
   because every leg uses `get_route`. Wire it through: tool returns
   structured data → server stores blocks → API returns blocks → ChatPanel
   renders card. Get this one right, then duplicate the pattern for the
   rest.

5. **Update Penny's prompt.** New rules: "When you call a tool, do not
   restate its output in prose. Your text should be intent and connection
   between cards, not data." Test with a deliberately-misleading scenario:
   ask Penny to plan a leg, see if she invents a wrong distance in prose
   while the card shows the right one.

6. **Migrate the existing chat history.** Wrap legacy rows as
   `[{type: 'prose', text: row.content}]`. Verify a trip with old chat
   still loads.

7. **Kill `changes` from the replan response.** Once the chat renders
   tool-use cards directly, the workspace doesn't need a separate
   `changes` array — the cards are the changes. Remove that path so we
   don't drift.

---

## Open questions for future-Sam

1. Do interactive cards (Add / Skip / Confirm) call tools client-side, or
   does the user's tap re-enter Penny's loop ("user picked option 2")?
   First is faster, second keeps Penny aware of state. Probably first for
   simple add/skip and second for anything that needs replanning.
2. How do we render Penny's *thinking* (multi-step tool calls) — show every
   tool call as a card, or fold the intermediate ones into a "Penny is
   working…" indicator and only surface the result cards? Latter is
   cleaner; former is more transparent.
3. Cards in chat vs. cards in the workspace — when do we surface the same
   data in both, and when does one suppress the other? If a leg already
   shows a fuel stop in the workspace map, does the chat still show a
   `<FuelStopOptionCard>` for it, or just say "I added it"?
4. Should the chat support inline editing of card data (e.g. drag-to-adjust
   the polyline preview), or is that strictly a workspace concern? Defer
   until users ask.
