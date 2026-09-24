/**
 * Parallel lanes: one job's slices spread across Durable Objects of one class.
 *
 * Not re-exported from the package root, because the lane class extends `DurableObject` from
 * `cloudflare:workers`, which only resolves inside workerd.
 *
 * @since 1.1.0
 */
export { LaneChannel, type ChannelMessage } from './parallel/channel.js';
export {
	defineLane,
	handleLaneRequest,
	type LaneClass,
	type LaneConfig,
	type LaneStateContext,
	type LaneTaskFn,
	type StateTags,
	type TaskContext
} from './parallel/lane.js';
export {
	LanePool,
	LaneScope,
	type BuildSteps,
	type GuestWork,
	type LanePoolOptions,
	type PoolHealth,
	type RunOptions,
	type RuntimeWork,
	type TaskWork,
	type Work
} from './parallel/pool.js';
export { LaneTask, type LaneResult, type ResultKind } from './parallel/result.js';
export type { JobStats } from './parallel/scheduler.js';
export { LaneAtomic, LaneLease, LaneMutex, type AcquireOptions } from './parallel/sync.js';
