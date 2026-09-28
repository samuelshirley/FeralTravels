import type { ValidatedAction } from '@/lib/penny/tools';

// ---------------------------------------------------------------------------
// Legacy `changes` envelope shim
//
// The frontend (ChatPanel) reads `data.changes.changes[]` to decide whether
// Penny proposed any changes. Until we update the client, keep emitting the
// pre-existing `{ action, ...flat }` shape so probes like
// `Array.isArray(data?.changes?.changes)` keep working.
//
// Lives here rather than in api/trip/replan/route.ts because a Next route file
// may export only HTTP handlers, and the seeded transcript
// (src/server/seededTranscript.ts) writes the same `changes_made` envelope a
// real handoff turn does, through this one function.
// ---------------------------------------------------------------------------
export function actionToLegacyChange(action: ValidatedAction): Record<string, unknown> {
  switch (action.name) {
    case 'update_vehicle':
      return { action: 'update_vehicle', data: action.input.data };
    case 'add_leg':
      return { action: 'add_leg', data: action.input };
    case 'delete_leg':
      return { action: 'delete_leg', leg_id: action.input.leg_id };
    case 'update_leg':
      return { action: 'update_leg', leg_id: action.input.leg_id, data: action.input.data };
    case 'add_route':
      return { action: 'add_route', leg_id: action.input.leg_id, data: action.input.data };
    case 'update_route':
      return {
        action: 'update_route',
        route_id: action.input.route_id,
        data: action.input.data,
      };
    case 'delete_route':
      return { action: 'delete_route', route_id: action.input.route_id };
    case 'add_stop':
      return { action: 'add_stop', leg_id: action.input.leg_id, data: action.input.data };
    case 'update_stop':
      return { action: 'update_stop', stop_id: action.input.stop_id, data: action.input.data };
    case 'delete_stop':
      return { action: 'delete_stop', stop_id: action.input.stop_id };
    case 'add_task':
      return {
        action: 'add_task',
        leg_id: action.input.leg_id ?? null,
        data: action.input.data,
      };
    case 'update_task':
      return { action: 'update_task', task_id: action.input.task_id, data: action.input.data };
    case 'rename_trip':
      return {
        action: 'rename_trip',
        ...(action.input.name !== undefined ? { name: action.input.name } : {}),
        ...(action.input.start_date ? { start_date: action.input.start_date } : {}),
      };
    case 'report_position':
      return {
        action: 'report_position',
        lat: action.input.lat,
        lng: action.input.lng,
        ...(action.input.place_name ? { place_name: action.input.place_name } : {}),
        ...(action.input.next_leg_id ? { next_leg_id: action.input.next_leg_id } : {}),
      };
    case 'submit_idea':
      return { action: 'submit_idea', idea: action.input.idea };
  }
}
