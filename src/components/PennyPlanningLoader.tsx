// Deprecated: the planning clip is now a persistent Penny message rendered via
// PennyPlanningVideo (no longer a transient loader). This re-export only avoids
// a dangling import; safe to `git rm` once nothing references this path.
export { default } from './PennyPlanningVideo';
