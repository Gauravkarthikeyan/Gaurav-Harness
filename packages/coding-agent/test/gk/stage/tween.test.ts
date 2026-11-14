import { describe, expect, it } from "bun:test";
import type { Rect } from "../../../src/gk/stage/layout";
import { easeOutCubic, lerpWeights, RectTween, WeightTween } from "../../../src/gk/stage/tween";

describe("tween", () => {
	it("eases out cubically", () => {
		expect(easeOutCubic(0)).toBe(0);
		expect(easeOutCubic(0.5)).toBe(0.875);
		expect(easeOutCubic(1)).toBe(1);
	});

	it("interpolates rects at the midpoint and settles at 150 ms", () => {
		const clock = { t: 0 };
		const tween = new RectTween({ now: () => clock.t });
		const from = new Map<string, Rect>([["a", { x: 0, y: 0, w: 100, h: 40 }]]);
		const to = new Map<string, Rect>([["a", { x: 0, y: 0, w: 20, h: 40 }]]);
		tween.start(from, to);
		clock.t = 75;
		expect(tween.sample().get("a")).toEqual({ x: 0, y: 0, w: 30, h: 40 });
		expect(tween.active).toBe(true);
		clock.t = 150;
		expect(tween.sample().get("a")).toEqual({ x: 0, y: 0, w: 20, h: 40 });
		expect(tween.active).toBe(false);
	});

	it("grows entering rects from their centre and drops zero-area ones", () => {
		const clock = { t: 0 };
		const tween = new RectTween({ now: () => clock.t });
		tween.start(new Map(), new Map([["n", { x: 10, y: 10, w: 20, h: 10 }]]));
		expect(tween.sample().has("n")).toBe(false);
		clock.t = 75;
		expect(tween.sample().get("n")).toEqual({ x: 11, y: 11, w: 18, h: 8 });
	});

	it("snaps when motion is off", () => {
		const tween = new RectTween({ now: () => 0, motion: false });
		const to = new Map([["a", { x: 5, y: 5, w: 30, h: 10 }]]);
		tween.start(new Map([["a", { x: 0, y: 0, w: 10, h: 10 }]]), to);
		expect(tween.sample().get("a")).toEqual({ x: 5, y: 5, w: 30, h: 10 });
	});

	it("tweens weights in from 0 and out to 0", () => {
		const w = lerpWeights(new Map([["old", 4]]), new Map([["new", 2]]), 0.5);
		expect(w.get("old")).toBe(2);
		expect(w.get("new")).toBe(1);

		const clock = { t: 0 };
		const tween = new WeightTween({ now: () => clock.t });
		tween.set(new Map([["a", 2]]), 0);
		tween.start(new Map([["a", 2], ["b", 4]]), 0.4);
		clock.t = 75;
		const mid = tween.sample();
		expect(mid.weights.get("b")).toBe(3.5);
		expect(mid.railFraction).toBeCloseTo(0.35, 10);
		clock.t = 200;
		expect(tween.sample()).toEqual({ weights: new Map([["a", 2], ["b", 4]]), railFraction: 0.4, done: true });
	});
});
