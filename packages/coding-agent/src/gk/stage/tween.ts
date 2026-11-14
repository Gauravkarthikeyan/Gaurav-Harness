/**
 * Layout tweening (spec §5.5 step 8). The spec-preferred path interpolates tile weights and the
 * rail fraction and re-runs `layoutStage` per frame (every frame a valid tiling); `RectTween`
 * interpolates rects directly for surfaces that do not re-layout. Clock is injected.
 */
import type { Rect } from "./layout";

export const TWEEN_MS = 150;

export function easeOutCubic(t: number): number {
	const c = Math.min(1, Math.max(0, t));
	return 1 - (1 - c) ** 3;
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
	const x1 = Math.round(a.x + (b.x - a.x) * t);
	const y1 = Math.round(a.y + (b.y - a.y) * t);
	const x2 = Math.round(a.x + a.w + (b.x + b.w - (a.x + a.w)) * t);
	const y2 = Math.round(a.y + a.h + (b.y + b.h - (a.y + a.h)) * t);
	return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** New ids grow from 0, leaving ids shrink to 0 (spec: tiles tween in/out by weight). */
export function lerpWeights(
	from: ReadonlyMap<string, number>,
	to: ReadonlyMap<string, number>,
	t: number,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const [id, b] of to) {
		const a = from.get(id) ?? 0;
		out.set(id, a + (b - a) * t);
	}
	for (const [id, a] of from) if (!to.has(id)) out.set(id, a * (1 - t));
	return out;
}

export interface TweenOptions {
	now: () => number;
	durationMs?: number;
	/** Motion off → every tween snaps to its target. */
	motion?: boolean;
}

class Clocked {
	readonly #now: () => number;
	readonly #duration: number;
	motion: boolean;
	#startedAt: number | null = null;

	constructor(options: TweenOptions) {
		this.#now = options.now;
		this.#duration = options.durationMs ?? TWEEN_MS;
		this.motion = options.motion ?? true;
	}

	begin(): void {
		this.#startedAt = this.motion && this.#duration > 0 ? this.#now() : null;
	}

	snap(): void {
		this.#startedAt = null;
	}

	/** Eased progress in [0, 1]; 1 when idle or snapped. */
	progress(): number {
		if (this.#startedAt === null) return 1;
		const raw = (this.#now() - this.#startedAt) / this.#duration;
		if (raw >= 1) {
			this.#startedAt = null;
			return 1;
		}
		return easeOutCubic(raw);
	}

	get active(): boolean {
		return this.progress() < 1;
	}
}

/** Weight + rail-fraction tween feeding `layoutStage` each frame. */
export class WeightTween extends Clocked {
	#from = new Map<string, number>();
	#to = new Map<string, number>();
	#fromRail = 0;
	#toRail = 0;

	/** Start from the current sample toward new targets. */
	start(to: ReadonlyMap<string, number>, toRail: number): void {
		const current = this.sample();
		this.#from = current.weights;
		this.#fromRail = current.railFraction;
		this.#to = new Map(to);
		this.#toRail = toRail;
		this.begin();
	}

	/** Jump to targets immediately (motion off, terminal resize). */
	set(to: ReadonlyMap<string, number>, toRail: number): void {
		this.#from = new Map(to);
		this.#to = new Map(to);
		this.#fromRail = toRail;
		this.#toRail = toRail;
		this.snap();
	}

	sample(): { weights: Map<string, number>; railFraction: number; done: boolean } {
		const t = this.progress();
		if (t >= 1) return { weights: new Map(this.#to), railFraction: this.#toRail, done: true };
		return {
			weights: lerpWeights(this.#from, this.#to, t),
			railFraction: this.#fromRail + (this.#toRail - this.#fromRail) * t,
			done: false,
		};
	}
}

function collapsed(rect: Rect): Rect {
	return { x: rect.x + Math.floor(rect.w / 2), y: rect.y + Math.floor(rect.h / 2), w: 0, h: 0 };
}

/** Direct rect interpolation; entering rects grow from their centre, leaving rects shrink into it. */
export class RectTween extends Clocked {
	#from = new Map<string, Rect>();
	#to = new Map<string, Rect>();

	start(from: ReadonlyMap<string, Rect>, to: ReadonlyMap<string, Rect>): void {
		this.#from = new Map(from);
		this.#to = new Map(to);
		this.begin();
	}

	/** Interpolated rects; zero-area rects are dropped. */
	sample(): Map<string, Rect> {
		const t = this.progress();
		const out = new Map<string, Rect>();
		if (t >= 1) {
			for (const [id, r] of this.#to) if (r.w > 0 && r.h > 0) out.set(id, r);
			return out;
		}
		for (const [id, b] of this.#to) {
			const r = lerpRect(this.#from.get(id) ?? collapsed(b), b, t);
			if (r.w > 0 && r.h > 0) out.set(id, r);
		}
		for (const [id, a] of this.#from) {
			if (this.#to.has(id)) continue;
			const r = lerpRect(a, collapsed(a), t);
			if (r.w > 0 && r.h > 0) out.set(id, r);
		}
		return out;
	}
}
