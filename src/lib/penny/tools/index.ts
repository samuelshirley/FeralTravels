import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import type { PennyContext } from '@/lib/penny/context';

import * as addLeg from './addLeg';
import * as updateLeg from './updateLeg';
import * as deleteLeg from './deleteLeg';
import * as addRoute from './addRoute';
import * as updateRoute from './updateRoute';
import * as deleteRoute from './deleteRoute';
import * as addStop from './addStop';
import * as updateStop from './updateStop';
import * as deleteStop from './deleteStop';
import * as planFuelStops from './planFuelStops';
import * as planDumpStationStops from './planDumpStationStops';
import * as planOvernightStop from './planOvernightStop';
import * as addTask from './addTask';
import * as updateTask from './updateTask';
import * as getRoute from './getRoute';
import * as extractTripIntent from './extractTripIntent';
import * as checkTripFeasibility from './checkTripFeasibility';
import * as updateVehicle from './updateVehicle';
import * as renameTrip from './renameTrip';
import * as reportPosition from './reportPosition';
import * as submitIdea from './submitIdea';

export {
  addLeg,
  updateLeg,
  deleteLeg,
  addRoute,
  updateRoute,
  deleteRoute,
  addStop,
  updateStop,
  deleteStop,
  planFuelStops,
  planDumpStationStops,
  planOvernightStop,
  addTask,
  updateTask,
  getRoute,
  extractTripIntent,
  checkTripFeasibility,
  updateVehicle,
  renameTrip,
  reportPosition,
  submitIdea,
};

/**
 * Every tool definition in one array — the shape Anthropic expects for the
 * `tools` parameter on messages.create.
 */
export const TOOLS: Anthropic.Tool[] = [
  // Order matters for prompt salience — Penny reads the tool list top-down.
  // The required workflow gate is: extract_trip_intent → get_route ×N →
  // check_trip_feasibility → add_leg ×N. List the gates first so their
  // "call me before X" wording lands prominently.
  extractTripIntent.tool,
  getRoute.tool,
  planOvernightStop.tool,
  checkTripFeasibility.tool,
  updateVehicle.tool,
  renameTrip.tool,
  reportPosition.tool,
  submitIdea.tool,
  addLeg.tool,
  updateLeg.tool,
  deleteLeg.tool,
  addRoute.tool,
  updateRoute.tool,
  deleteRoute.tool,
  addStop.tool,
  updateStop.tool,
  deleteStop.tool,
  planFuelStops.tool,
  planDumpStationStops.tool,
  addTask.tool,
  updateTask.tool,
];

/**
 * Tool names that *write* to the DB. Their inputs go through Zod validation
 * during the tool-use loop and the validated payloads are dispatched after
 * Claude finishes her turn (see src/app/api/trip/replan/route.ts).
 */
export const ACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  updateVehicle.UPDATE_VEHICLE,
  renameTrip.RENAME_TRIP,
  reportPosition.REPORT_POSITION,
  submitIdea.SUBMIT_IDEA,
  addLeg.ADD_LEG,
  updateLeg.UPDATE_LEG,
  deleteLeg.DELETE_LEG,
  addRoute.ADD_ROUTE,
  updateRoute.UPDATE_ROUTE,
  deleteRoute.DELETE_ROUTE,
  addStop.ADD_STOP,
  updateStop.UPDATE_STOP,
  deleteStop.DELETE_STOP,
  planFuelStops.PLAN_FUEL_STOPS,
  planDumpStationStops.PLAN_DUMP_STATION_STOPS,
  addTask.ADD_TASK,
  updateTask.UPDATE_TASK,
]);

/**
 * Tool names that don't write to the DB — they're "function" tools Claude
 * calls to get information mid-turn. The server executes them inside the
 * loop and feeds the result back as a tool_result block.
 */
export const LOOKUP_TOOL_NAMES: ReadonlySet<string> = new Set([
  getRoute.GET_ROUTE,
  extractTripIntent.EXTRACT_TRIP_INTENT,
  checkTripFeasibility.CHECK_TRIP_FEASIBILITY,
  planOvernightStop.PLAN_OVERNIGHT_STOP,
]);

/**
 * Validator factory registry — maps tool name to a function that takes the
 * current PennyContext and returns the Zod schema. Cross-field rules
 * (drive_time vs vehicle cap, distance_from_start vs leg distance) live in
 * those factories so they pick up live trip state.
 */
export const VALIDATORS: Record<string, (ctx: PennyContext) => z.ZodSchema<unknown>> = {
  [updateVehicle.UPDATE_VEHICLE]: updateVehicle.validator,
  [renameTrip.RENAME_TRIP]: renameTrip.validator,
  [reportPosition.REPORT_POSITION]: reportPosition.validator,
  [submitIdea.SUBMIT_IDEA]: submitIdea.validator,
  [addLeg.ADD_LEG]: addLeg.validator,
  [updateLeg.UPDATE_LEG]: updateLeg.validator,
  [deleteLeg.DELETE_LEG]: deleteLeg.validator,
  [addRoute.ADD_ROUTE]: addRoute.validator,
  [updateRoute.UPDATE_ROUTE]: updateRoute.validator,
  [deleteRoute.DELETE_ROUTE]: deleteRoute.validator,
  [addStop.ADD_STOP]: addStop.validator,
  [updateStop.UPDATE_STOP]: updateStop.validator,
  [deleteStop.DELETE_STOP]: deleteStop.validator,
  [planFuelStops.PLAN_FUEL_STOPS]: planFuelStops.validator,
  [planDumpStationStops.PLAN_DUMP_STATION_STOPS]: planDumpStationStops.validator,
  [addTask.ADD_TASK]: addTask.validator,
  [updateTask.UPDATE_TASK]: updateTask.validator,
  [getRoute.GET_ROUTE]: getRoute.validator,
  [extractTripIntent.EXTRACT_TRIP_INTENT]: extractTripIntent.validator,
  [checkTripFeasibility.CHECK_TRIP_FEASIBILITY]: checkTripFeasibility.validator,
  [planOvernightStop.PLAN_OVERNIGHT_STOP]: planOvernightStop.validator,
};

export type ValidatedAction =
  | { name: typeof updateVehicle.UPDATE_VEHICLE; input: updateVehicle.UpdateVehicleInput }
  | { name: typeof renameTrip.RENAME_TRIP; input: renameTrip.RenameTripInput }
  | { name: typeof reportPosition.REPORT_POSITION; input: reportPosition.ReportPositionInput }
  | { name: typeof submitIdea.SUBMIT_IDEA; input: submitIdea.SubmitIdeaInput }
  | { name: typeof addLeg.ADD_LEG; input: addLeg.AddLegInput }
  | { name: typeof updateLeg.UPDATE_LEG; input: updateLeg.UpdateLegInput }
  | { name: typeof deleteLeg.DELETE_LEG; input: deleteLeg.DeleteLegInput }
  | { name: typeof addRoute.ADD_ROUTE; input: addRoute.AddRouteInput }
  | { name: typeof updateRoute.UPDATE_ROUTE; input: updateRoute.UpdateRouteInput }
  | { name: typeof deleteRoute.DELETE_ROUTE; input: deleteRoute.DeleteRouteInput }
  | { name: typeof addStop.ADD_STOP; input: addStop.AddStopInput }
  | { name: typeof updateStop.UPDATE_STOP; input: updateStop.UpdateStopInput }
  | { name: typeof deleteStop.DELETE_STOP; input: deleteStop.DeleteStopInput }
  | { name: typeof planFuelStops.PLAN_FUEL_STOPS; input: planFuelStops.PlanFuelStopsInput }
  | { name: typeof planDumpStationStops.PLAN_DUMP_STATION_STOPS; input: planDumpStationStops.PlanDumpStationStopsInput }
  | { name: typeof addTask.ADD_TASK; input: addTask.AddTaskInput }
  | { name: typeof updateTask.UPDATE_TASK; input: updateTask.UpdateTaskInput };
