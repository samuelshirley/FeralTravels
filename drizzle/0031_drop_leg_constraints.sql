-- Drop the leg date-constraint feature.
--
-- `leg_constraints` held arrive_by / depart_after / flexible deadlines per leg,
-- with the `anchored` leg status ("DATE LOCKED") as its badge. It was never
-- reachable: no component rendered a constraint, no API route wrote one, and
-- the only way to create one was Penny attaching it to an `add_leg` call. What
-- it did reach was the schedule builder, which read dated constraints as
-- fixed-date anchors, and the plan summary card's deadline line.
--
-- Dropped rather than left dormant like `trips.trip_status` and `stops.photos`,
-- because unlike those this table has its own pg ENUM and an index behind it,
-- and a dormant table invites someone to wire it back up.
DROP TABLE IF EXISTS "leg_constraints";
DROP TYPE IF EXISTS "constraint_type";
